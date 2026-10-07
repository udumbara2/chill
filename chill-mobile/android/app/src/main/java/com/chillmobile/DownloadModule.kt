package com.chillmobile

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.Request
import java.io.File

/**
 * DownloadModule — 中继 static 产物的下载/安装原语（第一性定案 1/2/4）。
 *
 * 传输信任：复用 OkHttpClientProvider.client（MainApplication 证书固定的同一单例），
 * 仅 clone 出新 builder 关闭重定向（followRedirects(false)——静态通道无重定向语义）；
 * 绝不自建独立 client 的网络库（会绕开私有 CA 唯一信任根）。
 *
 * 安装三层闸之闸 1（包名预检）在 installApk 入口强制：非 com.chillmobile 的包
 * 根本不进 PackageInstaller（挡"链接指向另一个 App"社工面）；闸 2（签名校验）=
 * 系统安装器承重墙；闸 3（Content-Length 对账）在 fetchToCache 收尾执行。
 * 安装流用 Session API 字节流直入安装器——零 FileProvider/URI 暴露面。
 * 日志纪律：不记 URL（与服务端防枚举纪律同族）。
 */
class DownloadModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  init {
    reactCtx = reactContext
  }

  override fun getName(): String = "DownloadModule"

  private fun emit(event: String, data: com.facebook.react.bridge.WritableMap) {
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, data)
  }

  private fun sendProgress(received: Long, total: Long) {
    emit(
      "DownloadProgress",
      Arguments.createMap().apply {
        putDouble("received", received.toDouble())
        putDouble("total", total.toDouble())
      },
    )
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // RN 事件接口占位（NativeEventEmitter 要求存在）
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // 同上
  }

  /** 计量网络判定（供下载前确认；ACCESS_NETWORK_STATE） */
  @ReactMethod
  fun isMetered(promise: Promise) {
    try {
      val cm =
        reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      promise.resolve(cm.isActiveNetworkMetered)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /** 下载到 cacheDir/updates/（只保最新一份）；进度事件 DownloadProgress；Content-Length 对账；
   *  流式 sha256 随结果返回（更新发现的清单哈希对账——零额外读盘一遍）。
   *  线程纪律（实测教训）：必须 enqueue 到 OkHttp 线程池——同步 execute() 会占死 NativeModule
   *  线程，期间一切原生调用（isMetered/verifyPackage…）排队无响应（症状：下载中点按钮没反应）。 */
  @ReactMethod
  fun fetchToCache(url: String, destName: String, promise: Promise) {
    val safeName = destName.replace(Regex("[^A-Za-z0-9._-]"), "_")
    try {
      val dir = File(reactApplicationContext.cacheDir, "updates")
      dir.mkdirs()
      dir.listFiles()?.forEach { it.delete() } // 缓存生命周期：只保最新一份
      val dest = File(dir, safeName)
      val tmp = File(dir, "$safeName.part")
      val client =
        OkHttpClientProvider.getOkHttpClient().newBuilder() // 同一证书固定单例 clone，不动全局
          .followRedirects(false)
          .followSslRedirects(false)
          .build()
      val call = client.newCall(Request.Builder().url(url).build())
      currentCall = call
      call.enqueue(
        object : okhttp3.Callback {
          override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
            try {
              tmp.delete()
            } catch (_: Exception) {}
            if (currentCall === call) currentCall = null
            val canceled = e.message?.lowercase()?.contains("cancel") == true
            promise.reject(if (canceled) "canceled" else "fetch-failed", e)
          }

          override fun onResponse(call: okhttp3.Call, resp: okhttp3.Response) {
            try {
              resp.use { r ->
                if (!r.isSuccessful) {
                  promise.reject("http-${r.code}", "HTTP ${r.code}")
                  return
                }
                val body = r.body ?: run {
                  promise.reject("empty-body", "empty body")
                  return
                }
                val total = body.contentLength()
                var received = 0L
                val md = java.security.MessageDigest.getInstance("SHA-256")
                tmp.outputStream().use { out ->
                  body.byteStream().use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                      val n = input.read(buf)
                      if (n < 0) break
                      md.update(buf, 0, n)
                      out.write(buf, 0, n)
                      received += n
                      sendProgress(received, total)
                    }
                  }
                }
                // 闸 3：Content-Length 对账（损坏早发现）
                if (total >= 0 && received != total) {
                  tmp.delete()
                  promise.reject("length-mismatch", "length mismatch")
                  return
                }
                if (!tmp.renameTo(dest)) {
                  tmp.delete()
                  promise.reject("rename-failed", "rename failed")
                  return
                }
                val sha256 = md.digest().joinToString("") { "%02x".format(it) }
                promise.resolve(
                  Arguments.createMap().apply {
                    putString("path", dest.absolutePath)
                    putDouble("bytes", received.toDouble())
                    putString("sha256", sha256)
                  },
                )
              }
            } catch (e: Exception) {
              try {
                tmp.delete()
              } catch (_: Exception) {}
              val canceled = e.message?.lowercase()?.contains("cancel") == true
              promise.reject(if (canceled) "canceled" else "fetch-failed", e)
            } finally {
              if (currentCall === call) currentCall = null
            }
          }
        },
      )
    } catch (e: Exception) {
      promise.reject("fetch-failed", e)
    }
  }

  @ReactMethod
  fun cancelDownload() {
    try {
      currentCall?.cancel()
    } catch (_: Exception) {}
  }

  /** 闸 1：包名预检（独立可调——UI 可在安装前拿到布尔结果出可读文案） */
  @ReactMethod
  fun verifyPackage(filePath: String, promise: Promise) {
    try {
      val info = reactApplicationContext.packageManager.getPackageArchiveInfo(filePath, 0)
      promise.resolve(info?.packageName == reactApplicationContext.packageName)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /** API≥26 需"安装未知应用"授权；24-25 系统默认放行侧载（canRequest 自 API 26 起存在） */
  @ReactMethod
  fun canRequestPackageInstalls(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(true)
      return
    }
    try {
      promise.resolve(reactApplicationContext.packageManager.canRequestPackageInstalls())
    } catch (e: Exception) {
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun openUnknownSourcesSettings(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:" + ctx.packageName))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } else {
          Intent(Settings.ACTION_SECURITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      ctx.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("settings-failed", e)
    }
  }

  /** 闸 1 强制 + Session API 安装（零 URI 暴露）；结果经 InstallResultReceiver 回 'InstallResult' 事件 */
  @ReactMethod
  fun installApk(filePath: String, promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val file = File(filePath)
      if (!file.isFile) {
        promise.reject("no-file", "apk not found")
        return
      }
      val info = ctx.packageManager.getPackageArchiveInfo(filePath, 0)
      if (info?.packageName != ctx.packageName) {
        promise.reject("not-our-package", "not our package")
        return
      }
      val installer = ctx.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      val sessionId = installer.createSession(params)
      installer.openSession(sessionId).use { session ->
        file.inputStream().use { input ->
          session.openWrite("app.apk", 0, file.length()).use { out ->
            input.copyTo(out)
            session.fsync(out)
          }
        }
        val intent = Intent(ctx, InstallResultReceiver::class.java)
        val flags =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
          } else {
            PendingIntent.FLAG_UPDATE_CURRENT
          }
        val pi = PendingIntent.getBroadcast(ctx, sessionId, intent, flags)
        session.commit(pi.intentSender)
      }
      promise.resolve("started") // 系统确认页已发起；结果走 InstallResult 事件
    } catch (e: Exception) {
      promise.reject("install-failed", e)
    }
  }

  companion object {
    @Volatile private var currentCall: okhttp3.Call? = null
    @Volatile private var reactCtx: ReactApplicationContext? = null

    fun emitInstallResult(status: String, statusMessage: String?) {
      try {
        reactCtx
          ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit(
            "InstallResult",
            Arguments.createMap().apply {
              putString("status", status)
              if (statusMessage != null) putString("statusMessage", statusMessage)
            },
          )
      } catch (_: Exception) {}
    }
  }
}

/**
 * InstallResultReceiver — PackageInstaller 的结果回执。
 * 三类回调：
 * - STATUS_PENDING_USER_ACTION(-1)：不是失败！系统要求拉起确认页（extras 带 CONFIRM_INSTALL intent，
 *   必须代为 startActivity，否则安装永远停在"待用户确认"——2026-09-28 真机装包失败根因：旧代码把 -1 误判为 failed）；
 * - STATUS_SUCCESS → 'success'；STATUS_FAILURE_ABORTED（用户取消系统页）→ 'canceled'；其余 → 'failed'；
 *   EXTRA_STATUS_MESSAGE 一并透出（真实拒绝原因）。
 */
class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status =
      intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      // 系统要求用户确认：代为拉起确认页（NEW_TASK——广播回调不在 Activity 栈内）
      val confirm: Intent? = intent.getParcelableExtra(Intent.EXTRA_INTENT)
      if (confirm != null) {
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          context.startActivity(confirm)
        } catch (_: Exception) {}
      }
      return // 非终态：不通知 JS，等用户确认后的最终回执
    }
    val statusMessage = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
    val mapped =
      when (status) {
        PackageInstaller.STATUS_SUCCESS -> "success"
        PackageInstaller.STATUS_FAILURE_ABORTED -> "canceled"
        else -> "failed"
      }
    DownloadModule.emitInstallResult(mapped, statusMessage)
  }
}
