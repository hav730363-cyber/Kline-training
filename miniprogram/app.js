const CLOUD_ENV_ID = "sunshine-666-d9ge8hpcpa89e8b4c";

App({
  globalData: {
    cloudEnvId: CLOUD_ENV_ID,
    appId: "wx709f67396b06ba71"
  },
  onLaunch() {
    if (!wx.cloud) return;
    const envId = wx.getStorageSync("kline-cloud-env-id") || CLOUD_ENV_ID;
    wx.cloud.init(envId ? { env: envId, traceUser: true } : { traceUser: true });
  }
});
