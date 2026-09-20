/**
 * 在 maker.taptap.cn 页面里读取登录态，交给后台服务。
 *
 * 站点的 token 存在 localStorage（见其前端 bundle 里的常量表）：
 *   taptap_access_token / taptap_refresh_token / taptap_user
 * 这里只读不改，页面本身感知不到这个脚本的存在。
 */
(() => {
  const ACCESS_KEY = 'taptap_access_token';
  const REFRESH_KEY = 'taptap_refresh_token';
  const USER_KEY = 'taptap_user';
  const POLL_MS = 30_000;

  function readAuth() {
    let accessToken;
    try {
      accessToken = localStorage.getItem(ACCESS_KEY);
    } catch {
      return null; // 隐私模式下 localStorage 可能直接抛错
    }
    if (!accessToken) return null;

    let refreshToken = null;
    let user = null;
    try {
      refreshToken = localStorage.getItem(REFRESH_KEY);
    } catch {}
    try {
      user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {}
    return { accessToken, refreshToken, user };
  }

  // 同一个 token 不重复上报：后台可能已经拿它换过新 token，
  // 而页面里这份要等站点自己刷新才会变。
  let lastSent = null;

  function push(force) {
    const auth = readAuth();
    if (!auth) return;
    if (!force && auth.accessToken === lastSent) return;
    lastSent = auth.accessToken;
    try {
      chrome.runtime.sendMessage({ type: 'auth', payload: auth }, () => void chrome.runtime.lastError);
    } catch {
      // 扩展被重载或卸载，此时 chrome.runtime 会失效，忽略即可
    }
  }

  push(true);
  setInterval(() => push(false), POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) push(false);
  });
})();
