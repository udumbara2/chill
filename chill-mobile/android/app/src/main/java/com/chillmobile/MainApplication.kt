package com.chillmobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // 自定义原生模块注册点（无 autolink 的手写包）
          add(DownloadPackage())
          add(MediaStorePackage()) // d→m 收件交付（MediaStore Downloads/chill/）
          add(CaTrustPackage()) // TLS 信任动态化（规划迭代 B：三态信任的原生执行层）
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    installDynamicTrust()
    loadReactNative(this)
  }

  /**
   * TLS 信任装配（M2b 证书固定 → 2026-10-11 规划迭代 B 动态信任）：
   * 经 OkHttpClientProvider.setOkHttpClientFactory 注入——RN 内置 fetch 与 WebSocket 均
   * 派生自全局 OkHttp client（WebSocketModule.kt 经 getOkHttpClient 取此单例），对本 App
   * 一切出站连接生效（本 App 只与中继通信，不合并系统 CA 的缺省形态保持攻击面最小）。
   * 半公开接口刻意控制在最小：只换 TrustManager 侧（sslSocketFactory + 钉死的
   * DynamicTrustManager）；hostnameVerifier 保持 OkHttp 缺省。
   * （设计文档写的 setCustomClient 系笔误：RN 的公开 API 是 setOkHttpClientFactory。）
   *
   * 信任快照单源=CaTrustState：冷启动装缺省快照（内置 CA，现状逐位）；此后仅 JS 侧
   * CaTrustModule.setTrust 按扫码三态换装（volatile 引用替换——client 永不重建、
   * 在途连接不受影响、新握手即生效）。CA 缺失/损坏：fail-open 为系统默认（开发期可见日志）。
   *
   * WS 读长连探活（2026-10-03 与桌面同款义务）：pingInterval 只作用于 WebSocket 连接
   * （普通 HTTP 不受影响）——OkHttp 每 30s 协议层 ping，服务器 ws 库自动回 pong；路径
   * 静默死亡（NAT 回收/公网 IP 漂移）时连续 pong 缺失由 OkHttp 直接判死回调 onclose →
   * session.ts 既有指数退避重连。无此前手机 WS 是纯接收向，死了自己永远不知道
   * （2026-10-03 实测：手机狂发 HTTP 25 分钟、WS 在服务器侧早消失）。30s 与服务器心跳、
   * 桌面 core wsKeepalive 同值（约定钉住）。
   */
  private fun installDynamicTrust() {
    try {
      CaTrustState.ensureDefault(resources)
      val client: OkHttpClient = OkHttpClientProvider.createClientBuilder()
        .sslSocketFactory(CaTrustState.socketFactory, CaTrustState.dynamicTm)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
      OkHttpClientProvider.setOkHttpClientFactory { client }
    } catch (e: Exception) {
      android.util.Log.e("chill", "动态信任初始化失败（fail-open 系统默认）", e)
    }
  }
}
