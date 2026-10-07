package com.chillmobile

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.IOException

/**
 * MediaStoreModule — d→m 收件的系统下载目录交付原语（API 29+ 零权限写自建 Downloads 条目）。
 *
 * saveToDownloads：ContentResolver.insert（RELATIVE_PATH="Download/chill/"）+ IS_PENDING 两段式
 * （先占位 → 流式拷贝 → 置 0 发布——半截文件对系统其他应用不可见）；
 * DISPLAY_NAME 冲突自动改名 "name (1).ext"（与系统 SAF 行为一致，不覆盖用户既有文件）。
 *
 * openFile：ACTION_VIEW + FLAG_GRANT_READ_URI_PERMISSION（否则接收方 App 无权读 content URI）；
 * 失败统一诚实化不闪退：无应用可开 → no_handler；文件已被用户从系统删除 → gone。
 *
 * API < 29 不兜底、诚实报错（unsupported_api）——FileProvider 兜底链（manifest provider +
 * file_paths.xml + 双路径打开逻辑）是为十年前系统背复杂度，本项目真机为现代 Android，删。
 * 零新权限：targetSdk 34 + API 29+ 写自建 Downloads 条目免权限（官方文档实证）。
 */
class MediaStoreModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "MediaStoreModule"

  /** 同目录同名冲突时自动改名 "name (1).ext"（查 MediaStore 现存条目；防覆盖用户既有文件） */
  private fun uniqueDisplayName(collection: Uri, displayName: String): String {
    val resolver = reactApplicationContext.contentResolver
    val relPath = Environment.DIRECTORY_DOWNLOADS + "/chill/"
    fun exists(name: String): Boolean {
      val cursor =
        resolver.query(
          collection,
          arrayOf(MediaStore.MediaColumns._ID),
          "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.RELATIVE_PATH} = ?",
          arrayOf(name, relPath),
          null,
        )
      return cursor?.use { it.moveToFirst() } == true
    }
    if (!exists(displayName)) return displayName
    val dot = displayName.lastIndexOf('.')
    val stem = if (dot > 0) displayName.substring(0, dot) else displayName
    val ext = if (dot > 0) displayName.substring(dot) else ""
    for (n in 1..999) {
      val candidate = "$stem ($n)$ext"
      if (!exists(candidate)) return candidate
    }
    return "$stem-${System.currentTimeMillis()}$ext" // 理论兜底（999 个同名冲突）
  }

  /** 暂存明文 → Download/chill/（IS_PENDING 两段式）；返回 content URI（JS 侧交付完成后删暂存） */
  @ReactMethod
  fun saveToDownloads(srcPath: String, displayName: String, mime: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.reject("unsupported_api", "系统版本过低（API<29），无法保存到下载目录")
      return
    }
    try {
      val src = File(srcPath)
      if (!src.isFile) {
        promise.reject("io", "暂存文件不存在")
        return
      }
      val resolver = reactApplicationContext.contentResolver
      val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      // 路径分隔符防御性剥离（JS 侧已经 sanitizeFileName 清洗；此处双保险，DISPLAY_NAME 永不携路径）
      val safeName = displayName.replace(Regex("[/\\\\]"), "_").ifBlank { "file" }
      val name = uniqueDisplayName(collection, safeName)
      val values =
        ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, name)
          put(MediaStore.MediaColumns.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
          put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/chill/")
          put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
      val uri = resolver.insert(collection, values)
      if (uri == null) {
        promise.reject("io", "MediaStore 插入失败（存储不可用）")
        return
      }
      try {
        val out = resolver.openOutputStream(uri) ?: throw IOException("无法打开下载目录写入流")
        src.inputStream().use { input -> out.use { input.copyTo(it) } }
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        promise.resolve(uri.toString())
      } catch (e: Exception) {
        try {
          resolver.delete(uri, null, null) // 半截占位条目清场（不留幽灵文件）
        } catch (_: Exception) {}
        promise.reject("io", e)
      }
    } catch (e: Exception) {
      promise.reject("io", e)
    }
  }

  /** [打开]：ACTION_VIEW 系统分发（content URI + 读授权）；无应用可开/文件已删均诚实 reject */
  @ReactMethod
  fun openFile(uriString: String, mime: String, promise: Promise) {
    try {
      val uri = Uri.parse(uriString)
      // 文件已被用户从系统下载目录删除 → 诚实 gone（query 不到行）
      val exists =
        reactApplicationContext.contentResolver
          .query(uri, arrayOf(MediaStore.MediaColumns._ID), null, null, null)
          ?.use { it.moveToFirst() } == true
      if (!exists) {
        promise.reject("gone", "文件已不在下载目录")
        return
      }
      val intent =
        Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, mime.ifBlank { "*/*" })
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      reactApplicationContext.startActivity(intent)
      promise.resolve(null)
    } catch (e: ActivityNotFoundException) {
      promise.reject("no_handler", "没有能打开此类型文件的应用")
    } catch (e: Exception) {
      promise.reject("io", e)
    }
  }
}
