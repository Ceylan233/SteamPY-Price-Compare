# SteamPY Price Compare

Steam 商店价格增强脚本。

## 功能

- ✅ SteamPY 实时最低挂单价格（来自在售卖家列表）
- ✅ Steam 商店历史最低价及当前价对比
- ✅ SteamPY 余额购价格
- ✅ SteamPY 代购价格
- ✅ 商品详情页显示
- ✅ 购物车价格统计
- ✅ 愿望单价格显示
- ✅ 实时挂单/公开统计识别
- ✅ 自动计算节省金额

## 安装

安装 Tampermonkey 后，导入 `SteamPY.user.js` 即可。

## 实时价格与登录

SteamPY 的卖家挂单接口和游戏详情接口需要登录。安装脚本后：

1. 从 Tampermonkey 菜单点击“登录 SteamPY 并同步 Token”。
2. 在打开的 SteamPY 页面完成登录，脚本会自动同步登录状态。
3. 返回 Steam 商店刷新页面。

“PY实时最低”只使用卖家列表中有库存的最低 `CDKey` 单价，并缓存 2 分钟。SteamPY 自动计算的公开统计价不再显示。

普通游戏史低优先来自小黑盒的公开价格历史接口；接口返回空值时会降级到 Augmented Steam。固定 `subid` 套餐和 `bundleid` 组合包使用开源项目 Augmented Steam 的公开价格后端，并限定为中国区、Steam 商店。所有结果缓存 24 小时，不需要 SteamDB；两个接口均未收录时，普通游戏会继续尝试 SteamPY 登录后的详情数据。

史低链接会打开 IsThereAnyDeal 的对应价格历史页。以 X4 组合包 `30502` 为例，接口返回当前价 `¥366.40`、Steam 史低 `¥101.12`、史低折扣 `-72%`。

愿望单：
<img width="1129" height="1073" alt="image" src="https://github.com/user-attachments/assets/4055fb97-29a7-4311-b15c-35bdb0212313" />
购物车：
<img width="1070" height="1008" alt="image" src="https://github.com/user-attachments/assets/16f72dd7-9520-4185-802d-2b58e400d33e" />
商店页面：
<img width="741" height="1172" alt="image" src="https://github.com/user-attachments/assets/c08a76fa-55e4-4023-86d3-18d5d387063e" />
