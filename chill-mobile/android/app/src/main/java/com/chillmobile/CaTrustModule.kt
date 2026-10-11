package com.chillmobile

import android.content.res.Resources
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import okhttp3.OkHttpClient
import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * CaTrustModule — TLS 信任动态化执行层（2026-10-11 规划迭代 B，F1 手机侧）。
 *
 * 信任解析四行表（判定 SSOT 在 JS 侧 trust.ts/session.ts，本模块只执行）：
 * - pinned：只信 QR 带来的 CA（严格钉住，不并内置——作者 CA 不得成为第三方自建用户的
 *   隐式备用根，否则持作者私钥者可对用户中继域名签证书实施 MITM）
 * - system：系统 CA（WebPKI）；legacy/缺省：内置 res/raw/ca_crt（现状逐位，已配对态兼容锚）
 *
 * 实现纪律：
 * - 信任=可替换数据，不是可重建连接：DynamicTrustManager 持单一信任快照的 volatile 引用，
 *   swap 即生效——OkHttp client 永不重建、在途连接不受影响、新握手用新快照
 * - hostnameVerifier 保持 OkHttp 缺省（钉 CA 仍须核对"连的是不是这台服务器"——B1 注记①）
 * - system 态用平台缺省 TrustManagerFactory.init(null)：Android 应用进程默认信任源=系统 CA 库
 *   （targetSdk≥24 不含用户手装 CA，排除常见 MITM 向量；语义由 B4 实机复核——B1 注记②）
 */
class DynamicTrustManager : X509TrustManager {
  @Volatile private var current: X509TrustManager? = null

  fun swap(tm: X509TrustManager?) {
    current = tm
  }

  private fun required(): X509TrustManager =
    current ?: throw CertificateException("信任未初始化（缺省快照未装配）")

  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
    required().checkClientTrusted(chain, authType)

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
    required().checkServerTrusted(chain, authType)

  override fun getAcceptedIssuers(): Array<X509Certificate> = current?.acceptedIssuers ?: arrayOf()
}

object CaTrustState {
  val dynamicTm = DynamicTrustManager()

  private val sslContext: SSLContext =
    SSLContext.getInstance("TLS").also { it.init(null, arrayOf(dynamicTm), null) }

  val socketFactory: javax.net.ssl.SSLSocketFactory
    get() = sslContext.socketFactory

  /** 冷启动缺省快照：内置 CA（MainApplication.onCreate 调用；现状逐位兼容） */
  fun ensureDefault(resources: Resources) {
    dynamicTm.swap(builtInTm(resources))
  }

  fun applyTrust(pinnedCaB64: String?, useSystemCa: Boolean, resources: Resources) {
    val tm =
      when {
        pinnedCaB64 != null -> pinnedTm(pinnedCaB64)
        useSystemCa -> systemTm()
        else -> builtInTm(resources)
      }
    dynamicTm.swap(tm)
  }

  private fun tmFromKeystore(ks: KeyStore): X509TrustManager {
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    tmf.init(ks)
    return tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  private fun builtInTm(resources: Resources): X509TrustManager {
    val cf = CertificateFactory.getInstance("X.509")
    val ca = resources.openRawResource(R.raw.ca_crt).use { cf.generateCertificate(it) }
    val ks =
      KeyStore.getInstance(KeyStore.getDefaultType()).apply {
        load(null)
        setCertificateEntry("chill-relay-ca", ca)
      }
    return tmFromKeystore(ks)
  }

  private fun pinnedTm(caB64: String): X509TrustManager {
    val der =
      try {
        Base64.decode(caB64, Base64.DEFAULT)
      } catch (e: IllegalArgumentException) {
        throw IllegalArgumentException("caCert base64 解码失败", e)
      }
    val cf = CertificateFactory.getInstance("X.509")
    val ca = cf.generateCertificate(ByteArrayInputStream(der)) // 坏证书抛 CertificateException → 拒绝换装
    val ks =
      KeyStore.getInstance(KeyStore.getDefaultType()).apply {
        load(null)
        setCertificateEntry("pinned-relay-ca", ca)
      }
    return tmFromKeystore(ks)
  }

  private fun systemTm(): X509TrustManager {
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    // init(null as KeyStore?)：Kotlin 平台类型歧义需显式定型；null keystore = 平台缺省信任源
    tmf.init(null as KeyStore?)
    return tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
  }
}

/** JS 侧唯一入口：setTrust({pinnedCaB64?, useSystemCa?})——空参=缺省快照（legacy） */
class CaTrustModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CaTrustModule"

  @ReactMethod
  fun setTrust(opts: ReadableMap?, promise: Promise) {
    try {
      val pinned =
        if (opts?.hasKey("pinnedCaB64") == true) opts.getString("pinnedCaB64") else null
      val useSystem = opts?.hasKey("useSystemCa") == true && opts.getBoolean("useSystemCa")
      CaTrustState.applyTrust(pinned, useSystem, reactApplicationContext.resources)
      promise.resolve(true)
    } catch (e: Exception) {
      // 坏证书/坏 base64 → 拒绝换装（保持原快照）并如实回执，JS 侧据此中止配对
      promise.reject("ca_trust_error", e.message ?: e.javaClass.simpleName, e)
    }
  }

  /**
   * 引导取材（配对小码规划 R3）：一次性 GET，返回响应体文本（JSON {caB64}）。
   * 三铁律（planning §3）：①临时 OkHttpClient 与钉住单例物理隔离 ②hostname 校验保持
   * OkHttp 缺省逐位相同（IP SAN 场景现役依赖）③本方法只取材不设信任——材料真伪由
   * JS 侧 QR caFP 指纹锚校验（获取≠信任）。宽容 TrustManager 承担的仅是加密隧道：
   * MITM 替换材料会被锚拦死，hostname 仍按缺省校验。
   */
  @ReactMethod
  fun fetchCaAnonymously(url: String, promise: Promise) {
    val permissiveTm = object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
      override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }
    val client = OkHttpClient.Builder()
      .sslSocketFactory(
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(permissiveTm), null) }.socketFactory,
        permissiveTm,
      )
      // hostnameVerifier 不设 = OkHttp 缺省（铁律②）
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(10, TimeUnit.SECONDS)
      .build()
    Thread {
      try {
        val body = client.newCall(okhttp3.Request.Builder().url(url).get().build())
          .execute()
          .use { resp ->
            if (!resp.isSuccessful) {
              promise.reject("ca_fetch_http_${resp.code}", "取材 HTTP ${resp.code}")
              return@Thread
            }
            resp.body?.string() ?: ""
          }
        promise.resolve(body)
      } catch (e: Exception) {
        promise.reject("ca_fetch_error", e.message ?: e.javaClass.simpleName, e)
      }
    }.start()
  }
}
