// Web Push 的公开配置。私钥只在 Cloudflare Worker 的 secret 里，永远不进仓库。
// Worker 部署好后，把地址填到 PUSH_WORKER（结尾不要带斜杠）。
export const PUSH_WORKER = '';
export const PUSH_VAPID_PUBLIC_KEY = 'BMnKl7gO1BmBV8BPE9ZEKn3BEr4IgRqR2vy3egV0wyVKuvI7WEA7KAqn8bCKqddmcFGrJp-9nkekoi447V21Vw4';
