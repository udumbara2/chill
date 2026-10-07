package com.chillmobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.OkHttpClient
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // 自定义原生模块注册点（无 autolink 的手写包）
          add(DownloadPackage())
          add(MediaStorePackage()) // d→m 收件交付（MediaStore Downloads/chill/）
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    installPrivateCaPinning()
    loadReactNative(this)
  }

  /**
   * 证书固定（M2b）：私有 CA（res/raw/ca_crt）为唯一信任根，经
   * OkHttpClientProvider.setOkHttpClientFactory 注入——RN 内置 fetch 与 WebSocket 均
   * 派生自全局 OkHttp client（WebSocketModule.kt 经 getOkHttpClient 取此单例），对本 App
   * 一切出站连接生效（本 App 只与中继通信，不合并系统 CA，攻击面最小）。半公开接口刻意
   * 控制在最小：只换 TrustManager。
   * （设计文档写的 setCustomClient 系笔误：RN 的公开 API 是 setOkHttpClientFactory。）
   *
   * WS 读长连探活（2026-10-03 与桌面同款义务）：pingInterval 只作用于 WebSocket 连接
   * （普通 HTTP 不受影响）——OkHttp 每 30s 协议层 ping，服务器 ws 库自动回 pong；路径
   * 静默死亡（NAT 回收/公网 IP 漂移）时连续 pong 缺失由 OkHttp 直接判死回调 onclose →
   * session.ts 既有指数退避重连。无此前手机 WS 是纯接收向，死了自己永远不知道
   * （2026-10-03 实测：手机狂发 HTTP 25 分钟、WS 在服务器侧早消失）。30s 与服务器心跳、
   * 桌面 core wsKeepalive 同值（约定钉住）。
   */
  private fun installPrivateCaPinning() {
    try {
      val cf = CertificateFactory.getInstance("X.509")
      val ca = resources.openRawResource(R.raw.ca_crt).use { cf.generateCertificate(it) }
      val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
        load(null)
        setCertificateEntry("chill-relay-ca", ca)
      }
      val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
      tmf.init(ks)
      val tm = tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
      val sslContext = SSLContext.getInstance("TLS")
      sslContext.init(null, arrayOf(tm), null)
      val client: OkHttpClient = OkHttpClientProvider.createClientBuilder()
        .sslSocketFactory(sslContext.socketFactory, tm)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
      OkHttpClientProvider.setOkHttpClientFactory { client }
    } catch (e: Exception) {
      // CA 缺失/损坏：fail-open 为系统默认（开发期可见日志；发布包 CA 随包打入不会缺）
      android.util.Log.e("chill", "私有 CA pinning 初始化失败", e)
    }
  }
}
