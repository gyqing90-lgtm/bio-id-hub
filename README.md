# 物种鉴定聚合台（bio-id-hub）

一张图，提交到自选的若干个物种识别网站（可单站、可多站、也可全选），把返回结果归一化后
显示在同一个页面里，直接给出「几个站点一致指向哪个种」，并支持批量排队、导出 CSV。

---

> **本仓库不含任何账号、密码或 API Key**：凭据由使用者自己申请，只保存在本机
> `data/config.json`（加密）。申请入口、免费额度、各站的坑见
> [`账号与API申请指南.md`](账号与API申请指南.md)。
> 晓虫、植物智、文浩识蛾/识蝶、GBIF、内置名录这些站点**不需要任何凭据**。

---

## 一、怎么用

1. 双击目录里的 **`start.bat`**
   （没有反应就用命令行：`node server.js`）
2. 浏览器会自动打开 `http://127.0.0.1:8791`
3. **顶部「参与识别」下拉是主入口**（`#pick-group`）。它决定这一轮认什么、也决定下面摆多少模型：
   - **选某个类群**（昆虫 / 植物 / 鸟类 / 兽类 / 两爬 / 菌物 / 贝类）= 切过去并整组打开，
     下面只留「这一类群 **+ 能跟它同时开着的类群**」的整行模型（**每行都是全部模型，
     不只是已选的**，自己点开点关）：
     · 选「植物」→ 植物 + 多类群（植物跟多类群互斥，所以「多类群」里**只有 iNaturalist 能点**，
       多识·动物/百度·动物变灰）+ 不常用类群；
     · 选「昆虫 / 鸟类 / 兽类 / 两爬 / 菌物 / 贝类」→ 该类群 + 多类群 + 不常用类群。
   - **选「自动（混合）」**= 不指定类群，把所有类群的模型全部展开（一类群一行，
     植物 / 昆虫 / 鸟类 / 兽类 / 两爬 / 菌物 / 贝类 / 多类群 / 不常用类群）。
   - 「全选」「默认」两个按钮在右边：全选 = 当前类群全开 + 多类群 + 不常用类群；
     默认 = 回到 `DEFAULT_SELECTED`（多识·动物）。
   - **点类群名 = 整组开关**：本组全开时点一下全关，否则整组点开（同站只点一个）。
     被别的类群挡住的成员这次不开（植物模式下点「多类群」只会开 iNaturalist，toast 里会说）。

   - **类群互斥，一次只认一个类群**：选中某个类群后，其他专类群（植物 / 昆虫 / 鸟类 /
     兽类 / 两爬 / 菌物 / 贝类）的模型和类群名都会**变灰**，点它就等于切过去
     （原来那个类群的模型自动关掉）。两个例外：
     · 「不常用类群」（豆包、百度动/植物）不认类群，可以一直开着、独立勾选，
       默认**不勾**（灰着，要用自己点）；**其中豆包按次计费，是「点一次算一轮」**，
       切类群会被自动收回（见下一节）；
     · 「多类群」（多识·动物、iNaturalist、百度·动物）什么都能认，跟昆虫 / 鸟类 / 兽类 /
       两爬 / 菌物 / 贝类都能**同时开着**，只有跟「植物」互斥（选植物时它变灰，选它时植物变灰）——
       拿植物图去问动物模型基本只会给出错答案。**唯一例外是 iNaturalist**：它植物也认，
       所以植物模式下照旧能点、能跟植物模型一起开（见 `PLANT_SAFE`）。

   - **同一个网站的多个模型也互斥**：多识的动/植/鸟、懂鸟的鸟/兽/两爬、晓虫的六个分区、
     文浩的蝶/蛾、百度的动/植物，同一时间只能开一个。已经开了一个时，另一个会**变灰**，
     点它等于切过去（原来的自动关掉）。
   - **iNaturalist** 归「多类群」，默认**不勾**（灰着），要用自己点；点掉之后
     **不会再被自动加回来**（记在 `localStorage` 的 `bioAutoOff`）。
   - **eBird 的地区**：点站点条上的「eBird」会弹出地区选择（不在账号设置里）。给过定位权限的
     会打开就用浏览器定位猜一个省/国家，没授权则不主动请求（点「用我的定位」才问，见下），
     不对可以改，也可以手填代码；弹窗里还能「关掉 eBird」。
     确定地区等于选了「鸟类」类群（eBird 归在鸟类里）。
   - 默认勾选：多识·动物（多类群），下拉落在「自动（混合）」，所以打开就是全部模型展开。
     **豆包默认不勾**：它按量计费，规则是「点一次算一轮」（见下）。
     选择会记住（`localStorage` 的 `bioSelectedSites`，但豆包不记）；记住的是某个类群时，
     打开就是那个类群的一行模型。
4. 把照片拖进左侧方框（或点击选择、或直接 Ctrl+V 粘贴截图）
   - 支持一次多选，会排队逐张识别
   - 排队期间画面**不会一张张跳**：始终停在你正在看的那张，想换看哪张就点左侧列表
     （只有一张时自然就落在它身上）
5. 右侧会并列显示各站点自己的 Top5，下方是**合并结果**表
6. 顶部「点击物种名」可以选复制方式：
   - **不复制**：名字不可点，随便选字
   - **分别复制**（默认）：点拉丁名复制学名，点中文名复制中文名
   - **中文+拉丁**：点哪一处都复制「中文名 学名」整段

   复制方式记在浏览器里，下次打开保持。拖选文字时不会抢点击，选完照样能 Ctrl+C。
7. 页面最底部「友情链接」列出全部可参与识别的站点，点一下直达原站
8. 认完之后不想要这张了：右侧「删除这张」，或左侧列表每张右上角的 `×`
   → 只从列表移除并释放内存，**不会动硬盘上的原文件**
   → 5 秒内点提示条上的「撤销」可以恢复（撤销栈保留最近 5 张）
9. 想凑近看细节：点左侧列表的**缩略图**（或右侧「看大图」），图片摆到屏幕中央
   - **滚轮**上下 = 放大 / 缩小，放大以鼠标所在的位置为中心，不乱跑
   - **按住左键拖动** = 平移，用来看边角的翅脉、叶缘、菌褶
   - **双击图片** = 在「适应窗口」和「原始大小」之间切换
   - 顶部还有 `−` `+` `适应` `1:1` 四个按钮，中间实时显示当前百分比
   - `Esc`、点图片外面的黑色区域、或右上角 `×` 关闭
10. 标题旁边常驻**版本号**（`v1.0.17` 这样的小药丸），点一下等于手动查一次更新；
    查到新版会变成橙色，提示「该更新了」

> 关掉那个黑色命令行窗口 = 停止服务。

---

## 一之二、自然在线（站点键仍是 `xingse`）

自然在线（原「形色」，`ecp.ibiodiversity.cn/myNature`）现在**对所有人开放**：
站点条里叫「自然在线」，归在「植物」组，友情链接、设置面板里都有它，不需要任何暗号。
它跟动物类群互斥 —— 点它会自动切到「植物」并关掉动物那组（提示里会说关掉了哪些）。

- 以前它是隐藏站点（`hidden: true` + `Ctrl+Alt+X` 输暗号 `myNature` + `/api/hidden/unlock`），
  这套机制在 v1.0.48 整段移除；`/api/hidden/*` 现在是 404
- 站点键没跟着改名，前后端仍是 `xingse`，老配置和老令牌都不用迁移
- 它要登录：账号密码 + 一张图片验证码，令牌加密存在本机 `data/config.json`，
  之后的识别和名录查询都复用这张令牌
- 第一次用会失败一次属于正常（未登录），到「账号设置 → 自然在线登录」过一次验证码即可

实现：`lib/adapters.js` 里 `SITE_META.xingse`（`name/short` 是显示名，`hidden` 已删），
`server.js` 里 `allowSite()` / `visibleSites()` / `sanitizeConfig()` 已去掉隐藏过滤。

---

## 一之三、豆包（视觉理解）

> **准入规则：豆包是「点一次算一轮」的一次性模型。**
> 它按量计费（一张约 1 分钱，Key 由发布者承担），所以默认**灰着**，用户点一下才亮；
> **换类群就自动收回**（再点一次才回来）；「默认」「全选」都不带它；
> 关掉程序重开也不复活（`ONE_SHOT_SITES` + `dropOneShotSites()` 在 `public/app.js`）。
> 唯一例外：物种标注工坊用 `?sites=` 明确带过来时照开 —— 那等于用户刚在那边点过。
> 实现要点：`switchTaxonGroup(g)` 里判「g 原来不在 `activeTaxonGroups()` 里」才收回，
> 所以同类群内再点别的模型不会误关。

豆包**没有**公开的「传一张图给我鉴定」的网页接口。它的网页版
（`www.doubao.com/samantha/chat/completion`）要拿浏览器里的 `sessionid` cookie，
还得伪造 `device_id` / `msToken` / `a_bogus` 一堆设备指纹，图片要先走
`alice/resource/prepare_upload` 拿临时 STS 再按 AWS SigV4 传到 ImageX——
这套逆向十几步，字节一改就全废，不适合塞进要发给别人的工具里。

所以豆包走**官方火山方舟**，OpenAI 兼容格式，一次请求搞定：

```
POST https://ark.cn-beijing.volces.com/api/v3/chat/completions
Authorization: Bearer <ARK_API_KEY>
{
  "model": "doubao-seed-2-1-pro-260915",
  "messages": [{"role":"user","content":[
    {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,...","detail":"high"}},
    {"type":"text","text":"<让它只回 JSON 的提示词>"}
  ]}],
  "max_tokens": 600
}
```

**它和其他站点的本质区别**：别的站点是分类模型，直接吐概率；豆包是「看图说话」，
所以适配器用硬性提示词逼它只输出一段 JSON：

```json
{"taxon":"animal|plant|fungus|other",
 "candidates":[{"cn":"中文名","latin":"学名","confidence":0.0,"why":"≤20字依据"}]}
```

`confidence`（0~1）被当成百分制分数参与合并。**这是模型自报的把握，不是统计概率**，
和其他站点的 softmax 分数不在一个尺度上，所以合并算法里它只算一票，别指望它压过晓虫。

**怎么拿 Key**：火山引擎控制台 → 火山方舟 → 「**开通管理**」先给模型点一次开通
（不开通会返回 `404 ModelNotOpen`），再到「API Key 管理」创建 Key。
本仓库不附带任何 Key：在「账号设置 → 豆包」里粘贴你自己的（申请方法见 `账号与API申请指南.md`）。

**必须关掉深度思考**：2.1 系列默认开启 thinking，一张图要推 2000 来字、耗时 **58 秒**；
请求体加 `thinking: {"type":"disabled"}` 后降到 **2~5 秒**，候选反而更收敛。
`max_tokens` 也从 600 收到 400（3~5 个候选够用）。换到不认该参数的模型时，
适配器会自动去掉它重试一次。

**费用**：`doubao-seed-2-1-pro` 输入 6 元 / 输出 30 元每百万 tokens，
单图按 `detail: high` 约 1280 tokens，一次识别算下来**约 1 分钱**；
平台对新模型有每日免费额度，日常零星用基本不花钱。嫌贵可以在设置里把模型 ID
换成 `doubao-seed-2-1-turbo`（3 元 / 15 元，单价减半）。

> 豆包的 Key 按**你自己的账号**计费，所以仓库里不放任何 Key：谁用谁付。
> 建议在方舟控制台「开通管理」里给你自己的账号设一个
> 设一个**用量上限**（到上限自动暂停），避免意外账单。

---

## 一之四、快瞳 AI（鸟类）

快瞳是专门的鸟类识别服务，国内 1400+ 鸟种，支持静止与飞行、可同时识别多只鸟并给出坐标。
它只认鸟 —— 拿植物或昆虫图去问，会明确返回「没认出鸟」。

### 接口的三个坑（都踩过）

1. **换令牌的参数名是 `accessKey` / `accessSecret`，不是 `key` / `secret`**。
   传错会返回 `{"status":400,"message":"缺少请求参数"}`，很容易误以为是密钥无效：
   ```
   GET https://ai.inspirvision.cn/s/api/getAccessToken?accessKey=APPID_xxx&accessSecret=xxx
   → {"code":0,"data":{"access_token":"<464 字符>"}}
   ```
2. **令牌必须放在 query 里**（`?token=<token>`），放 `Authorization: Bearer` 或 body 都会
   报「token不能为空」。过期返回 `401 尚未登录或token已经过期`，适配器会自动用密钥换新的。
3. **识别接口是 multipart，字段名固定为 `file`**。哪怕文档写着支持 `imgBase64`，
   用 JSON 传始终返回「file, imgUrl, imgBase64（必传，三选一）」。

### 国内模型 vs 全球模型

| 接口 | 说明 |
|---|---|
| `/s/api/domesticBirdType` | 国内鸟种（1400+），对中国特有 / 亚种区分更准 |
| `/s/api/birdGlobalType` | 全球鸟种，任何账号都能用 |
| `/s/api/birdType` | 商品版接口，权限独立 |

**开通状态是按产品算的**：当前这把密钥只开通了全球模型，调国内接口返回
`402 尚未开通产品权限，请联系客服申请`。所以适配器开机时探一次国内接口，
402 就自动退回全球模型并缓存结果 —— 等服务商开通了国内产品，重启即自动升级，不用改代码。

实测全球模型的短板很明显：东方喜鹊的照片被判成「北美喜鹊 *Pica hudsonia* 95%」，
正确的「喜鹊 *Pica serica*」只有 1%。**要准，得找快瞳客服开通国内鸟类产品。**

### 配置

在「账号设置 → 快瞳·鸟」填你自己的 accessKey + accessSecret，
两栏都留空 = 保持不变；换了密钥会自动作废旧令牌。

默认**不勾选**（它只认鸟，勾上会让每张非鸟图片都报一次「没认出鸟」），认鸟时手动点一下。

---

## 二、接入的站点（维护时看这里）

| 站点 | 接口 | 是否需要登录 |
|---|---|---|
| 多识·动物 `duoshi.bio` | `POST /api/auth/login` → `POST /api/imgs/?predict_group=general` | **需要** |
| 多识·鸟类 `/api/imgs/?predict_group=bird` | 同一个账号、同一个登录态，只换 `predict_group` | **需要** |
| 多识·植物 `/api/imgs/?predict_group=plant` | 同上 | **需要** |
| iNaturalist | `POST /www.inaturalist.org/session` 登录取 cookie → `GET /users/api_token` 换 JWT → `POST api.inaturalist.org/v1/computervision/score_image` | **需要**（JWT 24h 自动续期） |
| 晓虫·昆虫 `quarryman.cn/insect` | `POST /insect` 上传 → 302 跳到 `/insect?img=xxx` 结果页 → 解析 HTML 表格 | 不需要 |
| 晓虫·植物 `/plant` | 同上，路径换成 `/plant` | 不需要 |
| 晓虫·菌物 `/fungi` | 同上 | 不需要 |
| 晓虫·蛇类 `/snake` | 同上 | 不需要 |
| 晓虫·贝类 `/mollusk` | 同上 | 不需要 |
| 晓虫·月季 `/rose` | 同上 | 不需要 |
| 文浩识蛾 `butterflyai.cc` | `POST /uploadbut/` 直接返回 JSON（`info[]` 里含 `namecn` / `latin` / `per`） | 不需要 |
| 文浩识蝶 `/static/butweb/.../ai.html` | **同上一个接口**（官网两页共用 `/uploadbut/` 与同一个模型） | 不需要 |
| 植物智 iPlant `iplant.cn/stu/20k` | `POST /ashx/stuupload2.ashx`（multipart：`0=图片`、`stutype=20k`、`type=files`）→ `GET /ashx/getstulist.ashx?type=stuinfo&stuid=` → `stuscores[]` | 不需要（**只收 JPG**） |
| Pl@ntNet `my-api.plantnet.org` | `POST /v2/identify/{project}?api-key=…&nb-results=10`（multipart 字段名 `images`，只收 JPG/PNG，合计 ≤50MB）→ `results[].species.scientificNameWithoutAuthor` + `commonNames[]`，score 0~1，`remainingIdentificationRequests` 是当天余量 | **需要**（my.plantnet.org 免费 Key，500 次/天） |
| 自然在线 `ecp.ibiodiversity.cn/myNature` | 登录取 JWT → `POST /api/online/utils/file/upload/album/photo` 传进中转相册 → `POST /api/online/myNature/album/photo/identify/xingse` → 立刻删掉这张图 | **需要**（账号密码 + 图片验证码，人工输一次） |
| 豆包 `doubao.com` | 官方「火山方舟」`POST https://ark.cn-beijing.volces.com/api/v3/chat/completions`，OpenAI 兼容格式，`image_url` 直接塞 base64 data URL，提示词要求只回 JSON | **需要**（方舟 API Key） |
| 快瞳·鸟类 `inspirvision.cn` | `GET /s/api/getAccessToken?accessKey=&accessSecret=` 换令牌 → `POST /s/api/domesticBirdType?token=`（multipart，字段名 `file`），没开通就退回 `/s/api/birdGlobalType` | **需要**（accessKey + accessSecret） |
| 懂鸟·鸟 `ai.open.hhodata.com` | HHO 官方 API：`POST /api/v2/dongniao`（multipart：`image`、`upload=1`、`class=B`，header `api_key`）→ 拿 `resultid` → `POST /api/v2/dongniao` 传 `resultid` 轮询，返回 `[[box, list]]`，`list` 元素是 `[置信度, "中文名\|英文名\|拉丁名", 物种ID, 类别]`；`quota=1` 查剩余次数 | **需要**（api_key） |
| 懂鸟·兽 `/api/v2/dongniao` `class=M` | 同上，只换 `class`：M=兽类（3820 种）。共用 `dongniao` 的 api_key 与图像配额 | **需要**（同一把 key） |
| 懂鸟·两爬 `/api/v2/dongniao` `class=AR` | 同上，`class=AR` 一次同时要两栖（5589）+ 爬行（8592）。官方 `F`（其他1/鱼）标注 v3.0「敬请期待」，暂不提供 | **需要**（同一把 key） |
| 百度·动物 `aip.baidubce.com` | `POST /oauth/2.0/token`（`grant_type=client_credentials` + AK/SK）换 access_token → `POST /rest/2.0/image-classify/v1/animal?access_token=`（form：`image`=base64、`top_num=5`）→ `result[{name, score}]`；认不出返回 `name:"非动物"` | **需要**（API Key + Secret Key） |
| 百度·植物 `/rest/2.0/image-classify/v1/plant` | 同上换 token；`baike_num=1` 让首条带百科描述，从中抠「学名：Rosa chinensis」当拉丁名（它本身只给中文名）。认不出返回 `name:"非植物"` | **需要**（另一组 AK/SK） |
| eBird `api.ebird.org` | **不做图片识别**：`GET /v2/ref/taxonomy/ebird?fmt=json&species=A,B` 学名→`speciesCode`（可逗号批量），再 `GET /v2/data/obs/{region}/recent/{code}?back=14` 取本地区近 14 天记录；header `X-eBirdApiToken` | **需要**（免费 API key） |

### 懂鸟为什么走 HHO 而不是网页版

网页版 `dongniao.net/photoid.html` 背后的 `/niaodian2` 带反机器人核验（服务器下发 5 位数字，
要在懂鸟小程序里输入才算通过），程序去调等于绕过对方风控 —— 不做。
懂鸟官方把识别能力开在 HHOLOVE 平台，`api_key` 鉴权、有文档、有配额查询，是正规通道。

两个实现细节：
- **异步**：上传只返回 `resultid`，要轮询「获取识别结果」。程序每 1.5 秒轮一次、最多 8 次（约 12 秒），
  轮询期间返回 `1001` 属正常。
- **查配额不花钱**：`quota=1` 不消耗配额，所以「保存并登录」用它做连通性检测，还能显示剩余次数。

申请与开通步骤见 `API申请与开通指引.md`。默认**不勾选**（按次计费，且只认鸟）。

**怎么拿 key**：注册后进 `/dashboard/keys/` 点复制；仓库不附带任何 key，谁用谁申请。
填进「账号设置 → 懂鸟 → apiKey」，加密保存在本机 `data/config.json`。
注册赠送 **图像 50 次 + 语音 300 秒**，验证用掉 3 次，剩约 47 次。
要查剩余额度：设置面板点「保存并登录」，或直接调 `POST /api/v2/dongniao` 带 `quota=1`
（不消耗配额）。控制台 <https://ai.open.hhodata.com/dashboard/keys/>。

> ⚠️ 额度按**你自己的账号**算：每识别一张鸟图扣一次，用完就停，充值后继续。
> 按 200 元/万次算，一次 2 分钱。给社团用之前先充值，或在站点条里把懂鸟点掉。

### 懂鸟的三个类群怎么分开

官方文档里 `class` 参数只接受 `B/M/A/R/F` 的组合（`BM` = 鸟 + 兽）。程序把
**鸟（B）/ 兽（M）/ 两爬（AR）** 拆成三个独立站点（`dongniao`、`dongniao-mammal`、
`dongniao-herp`），它们：

- `account: 'dongniao'` —— 共用同一份配置（`config.sites.dongniao.apiKey`），
  设置面板只在「懂鸟·鸟」下面显示输入框，另两个标「共用密钥」；
- 共用**同一份图像配额**，但**同一时间只能开一个**（`vendor: 'dongniao'` 触发同站互斥，
  开了鸟就点不了兽和两爬 —— 变灰，点它等于切过去）。所以一张图只扣一次；
- `dongniaoClass` 字段跟着 meta 一路传到 `identifyDongniao(img, cls)`，只换 `class`；
- 「保存并登录」（`quota=1`）一次把三个状态一起刷成「已连接（剩余 N 次）」。

`F`（其他1）与 `S`（其他2）在官方表格里是 v3.0 / v3.1「敬请期待」，现在调也拿不到结果，
所以没有做「懂鱼」。等官方开放，`DONGNIAO_CLASSES` 里加一行就行（`lib/adapters.js`）。

### 百度这两个接口的坑

- **只给中文名，不给拉丁学名**。植物接口带 `baike_num=1` 时首条的 `baike_info.description`
  里有「（学名：Rosa chinensis Jacq.）」，程序用正则抠出属名 + 种加词当拉丁名；
  动物接口的 `baike_info.description` 实测为空，只能靠中文名归并（见「合并结果怎么算的」）。
- 认不出不是「空数组」，而是 `name` 为 `"非动物"` / `"非植物"`，要单独判掉，
  否则会当成一个叫「非动物」的物种。
- 两个接口是**两套独立产品、各自计费**，AK/SK 也可能是两套（本项目就是两套），
  所以 `baidu-animal` 与 `baidu-plant` 是两个站点、各存各的密钥。
- access_token 有效期 30 天。程序缓存在内存里（25 天），**不写盘** —— token 本身就是凭据，
  没必要在密文配置旁边再放一份明文。收到 `110/111`（无效/过期）会自动换新重试一次。
- 「保存并登录」只换 token、不识别，用来验密钥不烧额度。
- 同一把 AK 调 `advanced_general`（通用物体）会返回 `error_code: 3 Unsupported openapi method`
  —— 那是另一个产品，没开通就没有权限。

### eBird 为什么只做「记录核对」

eBird 的图片识别（Merlin）不对外开放，官方 API 全是**观测数据**接口。硬把它当识别站点接进来
只有一个办法：拿别的站点的候选去反查——那就成了自欺欺人。所以它的位置是**识别之后的旁证**：

```
各站识别 → Top5 合并 → 取前 6 个学名 → eBird: 学名→speciesCode → 本地区近 14 天记录数
                                    → 合并表最右一列「63 条 / 0 条 / 非鸟类」
```

实现要点：
- **不参与投票**：`SITE_META.ebird.verify = true`，`/api/identify` 会把它从识别名单里剔掉，
  `aggregate()` 也见不到它 —— 综合得分和结论一个字都不受影响。
- **一次批量换码**：`species=` 支持逗号分隔，6 个候选只花 1 次 taxonomy + 每个鸟种 1 次 obs。
- **缓存**：学名映射 7 天、记录数 1 天，落在 `data/ebird-cache.json`（明文，里面只有物种代码和条数）。
- **非鸟类不硬查**：taxonomy 返回空数组就是「不在鸟类名录」，界面显示「非鸟类」而不是「0 条」——
  这两个含义完全不同。
- **地区在站点条上选，不在账号设置里**：点「eBird」这个按钮就弹窗（`#region-modal`），
  弹窗里是「下拉 + 可手填」——下拉由 `lib/ebird.js` 的 `REGIONS` 生成（中国 31 个省区 +
  港澳台 + 常见国家，共 89 个），输入框兜底，可以填任何 eBird 认的代码
  （`CN-35` 福建、`US` 美国、`JP` 日本、`TW` 中国台湾…）。`SITE_META.ebird.fields` 里给
  `region` 打了 `hideInSettings: true`，设置面板只留 API key，并提示「地区点 eBird 改」。
- **打开弹窗时只在已授权的情况下定位**：`autoLocateIfAllowed()` 先查
  `navigator.permissions.query({name:'geolocation'})`，只有 `granted` 才调 `locateRegion()`。
  **不能一打开就请求**：浏览器那个「允许使用你的位置？」气泡会挡住整页，用户不点掉它，
  连弹窗里的「确定」都点不动（1.0.48 修的就是这个）。没授权就让用户点「用我的定位」自己触发。
- **定位**：`navigator.geolocation` 拿经纬度 → `GET /api/ebird/region?lat&lng`
  → `ebird.regionAt()`。换算不靠本地硬编码坐标表，而是借 eBird 自己的
  `/v2/ref/hotspot/geo`：附近观鸟热点每条都带 `subnational1Code`（`CN-35`、`JP-13`、`GB-ENG`），
  25/80/200/500 km 逐级放宽，取出现次数最多的那个码，再用 `REGIONS` 换成人话（`日本`）。
  定位被拒绝或没网就只提示「手动选一个」，不挡流程。**定位只是帮填，保存仍以输入框为准。**
- 点「确定」→ `POST /api/config` 落盘 → `POST /api/login {site:'ebird'}` 用新地区重探一次
  （状态栏「已连接（福建 · 最近一条是 北灰鹟）」）→ 当前这张图的 eBird 旁证按新地区重查。
  点「关掉 eBird」则只是退出本次核对，不改配置。再点一次按钮是「打开设置」，不会误关。
- 地区码拼错时 eBird 返回 404，`ebGet()` 会提示「地区码或物种代码不存在」。

  > 注意 `REGIONS` 里港澳台用的是国家层级代码 `HK / MO / TW`（eBird 就是这么分的），
  > 不是 `CN-91 / CN-92 / CN-71` —— 后者在 eBird 里不存在。缓存键是 `地区|speciesCode`，
  > 换地区不会串味。

**怎么拿 key**：注册 eBird 账号并通过邮箱验证后，用真实浏览器打开
`https://ebird.org/api/keygen` 自助生成（UUID 形式），填进站点条上的 eBird 弹窗
（地区码默认 `CN`，上海 `CN-31`）；仓库本身不带任何 key。
实测上海 14 天：树麻雀 63 条、白头鹎 81 条、白鹡鸰 54 条、丹顶鹤 0 条。

> eBird keygen 页面在境内直连不稳定，且挂了 Anubis 反爬（要做 JS 工作量证明）。
> 拿 key 的可靠做法：用真实 Chrome 打开 <https://ebird.org/api/keygen> 登录康奈尔账号 →
> 勾「我已阅读并且接受使用协议」→ 填项目名/用途 → 项目类型选 General、勾
> 「Websites, web-based platforms, mobile applications」+「Educational and artistic materials」
> → 提交后在 `https://ebird.org/api/request` 页面上直接给出 key。同一账号重复提交拿到的是同一个 key。

晓虫这 6 个分区是同一套后端，只是路径不同；代码里用 `SITE_META[key].path` 区分，
在 `lib/adapters.js` 的 `QUARRYMAN_GROUPS` 里加一行就能接新区块（比如以后开了 `/fish`）。

### 学名旁的「iNat」按钮：这个属在我这儿有多少种

合并表里每行学名后面有个很小的绿色 `iNat` 标，点它开新窗口跳 iNaturalist。它**不跳这个种**，
而是落到「某地区某属的物种清单」——因为认虫认花时真正想问的是「本地这个属到底有几种，
我认的这个是不是最像的那个」，单个种的页面回答不了这个。

链接长得像这样（`lib/inat.js` 的 `buildUrl()`）：

```
https://www.inaturalist.org/observations?locale=zh-CN&place_id=54517&taxon_id=55690&view=species
                                    简体中文 ┘        └ 福建      └ Pieris 属   └ 物种视图
```

> **`locale` 只能写 `zh-CN`，不能写 `zh`。** iNat 网页端的语言代码取自 Crowdin 项目
> `inaturalistweb`，中文只有 `zh-CN`（简体，已 100% 译完）、`zh-TW`（繁体）、`zh-HK`，
> **没有裸的 `zh`**；而官方文档写明「代码不可用或不指定时，站点默认回退 `locale=en`」。
> 所以早先写 `locale=zh` 的那一版，点过去是**整页英文**（俗名也给英文）—— 2026-10-27 修正。
> 实测：`locale=zh` → `<html lang="en">`、中文 11 字；`locale=zh-CN` → `lang="zh-CN"`、中文 1855 字。

这三段正好等于手工操作的三步：

| 手工操作 | 链接参数 | 说明 |
|---|---|---|
| 过滤器 → 更多过滤器 → 地点 | `place_id=` | 圈定检索区域；iNat 的 place_id 与 eBird 地区码是两套东西，这里做了映射表 |
| 搜索框输入**属名**而不是种名 | `taxon_id=`（拿不到就退回 `taxon_name=`） | 用 `lib/inat.genusOf()` 从学名取第一个词 |
| 点「物种」标签，看「N 种」 | `view=species` | 顶栏与网格直接给出该地区该属的种数 |

实现要点：
- **地区在主页面选**（不在账号设置里）：页面顶部有一行「检索地区」，
  - 左边下拉给常用地区，选项来自 `lib/inat.js` 的 `PLACES`
    （中国 + 31 个省级行政区 + 港澳台 + 68 个国家/地区 + 全世界，共 104 项，
    place_id 都是从 iNat places 接口查过并核对好的固定值），按「中国 / 省级行政区 / 各洲 / 不限」分 optgroup；
  - 右边输入框可以自己搜：`GET /api/inat/places?q=` → `/v1/places/autocomplete`，
    城市、县、保护区、公园都能搜到（中英文都行），选中后按 `placeId` 存。
  - 配置里两种存法：`{ place: 'CN-35' }` 常用地区，`{ placeId: 222739, placeName: '南平市武夷山市' }`
    自定义地区，`resolvePlace()` 里自定义优先。
  - 它**只影响这个按钮**，不参与识别，也不影响 iNat 这个站点本身。改完立刻把已经渲染出来的
    链接就地换掉（`refreshInatLinks()`），不用重新识别。
  - 为什么搬出来：改地区原来要开「账号设置」弹层、点保存、再等一轮登录，太重了；
    而它跟账号毫无关系，本质是「看结果时的观察范围」。
- **属名要解析成 taxon_id**：`POST /api/inat/taxa { names, hint }` → `/v1/taxa?q=..&rank=genus`.
  必须解析，因为**属名会同名**：`Pieris` 既是粉蝶属（55690）又是马醉木属（49706）。
  所以带 `hint`（当前类群），用 `iconic_taxon_id` / `ancestor_ids` 挑同名的正确那一个，
  挑不出来再退回「iNat 上观测最多的那个」。
- **缓存 + 限速**：属名→id 的结果缓存在进程内（`Map`），每个新属之间隔 120ms（未登录接口限 100 次/分）。
  解析失败不影响使用 —— 链接自动退回 `taxon_name=Pieris`，iNat 自己也能解析。
- **不阻塞渲染**：结果渲染完先出链接（可能还是 `taxon_name` 版），`hydrateInatLinks()` 在后台拿到 id 后
  就地把 `href` 换掉，不重绘，滚动位置不跳。
- **只给有学名的候选**：`genusOfLatin()` 只认「纯字母且 ≥3 位」的第一个词，百度这种只给中文名的
  候选不加按钮，免得跳到错的类群。

### 学名旁的「PPBC」按钮：这地方这个属长什么样（只在植物类群下出现）

合并表里学名后面还有个蓝色的 `PPBC` 标，点它开新窗口跳植物智中国植物图像库。
它落在「某个地区某属**有哪些种**」上：页首写着「检索 Rhododendron 武夷山市 福建省 共2206条」，
下面的卡片就是种名（鹿角杜鹃 `Rhododendron latoucheae`、丁香杜鹃 `R. farrerae`…），
每张都带拍摄者与拍摄地（`福建省 南平市 武夷山市`），适合核对「我在本地拍到的这个属，
这一带还有哪些近缘种、别人在附近拍的是什么样」。

```
https://ppbc.iplant.cn/list21?latin=Rhododendron&pro=福建省&didian=武夷山市&sel=like
                    └ 图片列表页   └ 属名（latin）└ 省全称（pro）└ 地点（didian） └ 模糊匹配
```

这几段正好等于：在 `ppbc.iplant.cn/search` 的「科、属、种名称」里输属名、
「省名」里输省、「地点」里输市县、勾上模糊匹配，再点检索那一套
（那个页面的「检索」按钮跳的就是 `/list21`，参数名是从 `/Scripts/advsearch21.js` 的
`btnok_Click()` 里读出来的：`#txtlatin → latin`、`#txtsppro → pro`、`#txtspces → didian`）。

> **`pro` 必须写全称。** 实测：传「福建」得到「抱歉，没有找到与"Rhododendron 福建"相关的图片」，
> 传「福建省」才是 284 条；内蒙古要写「内蒙古自治区」、港澳要写「香港特别行政区」、台湾写「台湾省」。
> 34 个省级行政区都用 `Artemisia` 逐个跑过（`.probe/ppbc-provs.js`），简称一律零结果、全称全部命中。

> **`sel=like` 不能省。** 它是高级检索页上那个「模糊匹配」单选项（`rb1=l` → `&sel=like`）。
> 不带它，服务端只回「鉴定到属」的照片，卡片上永远是「杜鹃花属 Rhododendron」，一条种名都没有；
> 带上它才是属下的种。同一条件实测：`Rhododendron` + 福建省，无 sel **284 条**（全是属级）、
> 带 sel **12960 条**（全是种级）。

> **`didian` 只能填一级地名，而且要中文。** 它是拍摄地的文本模糊匹配（LIKE），不是结构化字段。
> 拿 `Salix` + 福建省（全省 832 条）试：
> `didian=武夷山` 213、`didian=武夷山市` 213、**`didian=南平市武夷山市` 0**（多级拼起来是零结果）、
> `didian=Wuyishan` 0（英文不认）、`didian=武夷山国家级自然保护区` 7（只有真写了保护区的）。
> 所以 iNat 的「南平市武夷山市Wuyishan City」必须先拆成「武夷山市」再传 —— `cleanLocality()` 干这个：
> 去英文尾巴 → 取最细一级行政区 → 去掉保护区 / 公园后缀（「武夷山国家级自然保护区」→「武夷山」）。

> **站方的毛病：小写字母 `s` 会被吃掉。** `Ficus` 进页面变成 `Ficu`、`Rosa` 变成 `Ro a`、
> `Hibiscus rosa-sinensis` 变成 `Hibi cu ro a- inen i`。试过 `%73` 单编码和双重编码都不行
> （它在解码之后过滤），大写 `S` 开头的不受影响（`Salix` 正常）。好在它走包含匹配，
> 去掉 `s` 后绝大多数记录照样能出来，只是 `Rosa` 这种会混进含「ro a」的无关记录。
> 这是站方行为，手动去搜也一样 —— **不要为此去改属名**。`didian` 只放中文地名，碰不到这个毛病。

实现要点：

- **映射表只有一份**：`lib/ppbc.js` 的 `PROVINCE_BY_CODE`（iNat 地区代码 → PPBC 省名，
  如 `CN-35 → 福建省`）。`lib/adapters.js` 把它挂在 inaturalist 的 `place` 选项上（`ppbc` 字段）
  随配置一起下发，前端直接读 `inatPlace().ppbc`，不维护第二份表。
  反向的 `PROVINCE_BY_PLACE_ID`（place_id → 省名）也由它生成，用来从县 / 市 / 保护区顺着祖先链找省。
- **自定义地区怎么定到市 / 县**：选好地区那一刻，前端调一次 `GET /api/ppbc/region`，
  服务端查 iNat 的 `/v1/places/<id>`，用 `ancestor_place_ids` 判两件事：
  ① 在不在中国（链里有 `6903`，或链上有任何一个省份 id —— 港澳台在 iNat 里是顶级地区、
  祖先链里没有中国，靠后一条兜住）；② 属于哪个省。算出来的 `pro` / `didian` 随配置存下来
  （`ppbcFor` / `ppbcPro` / `ppbcDidian`），之后渲染、切类群、重开程序都不再联网。
  `ppbcFor` 存的是当时的 placeId，读的时候校验一次，换了地区不会用到上一次的旧值。
- **只在「植物」类群下出现**（`ppbcOn()` 判 `activeGroup() === 'plant'`）。因为同名属两边都有：
  `Pieris` 既是粉蝶属又是马醉木属，而 PPBC 里确实能搜到别人上传的「凤蝶属 Papilio」照片 ——
  不分类群就挂按钮，认蝴蝶会一路点到马醉木属的图片墙上。
- **切类群不重绘**：渲染时只输出一个空占位（`<span class="ppbc-slot" data-genus>`），
  `refreshPpbcChips()` 按当前类群填充或清空。选了昆虫小标立刻消失，切回植物原地长回来。
- **境外 / 全世界不带地区**：植物智只收中国（含港澳台）的植物照片，没有境外选项。
  自定义地区判定为境外时（日本、美国…）`pro` 和 `didian` 都不传，服务端 302 到属页 `/gen/<id>`。
  港澳台「地点 == 省名」时只传 `pro`，不叠一层同名的 `didian`。
- **它和 iNat 那个按钮互不影响**：同一个学名后面两个标并排，各跳各的；地区换了两边一起变。
- **边界**：页首那个「共 N 条」是**照片条数**，不是种数；同一个种可能好几十条。
  卡片上绝大多数是种名，但用户只拍到属、没鉴定到种的照片仍显示「杜鹃花属」。
  想要「该属一共多少个种」得看属页 `/gen/<id>`（那个不分地区）。
  `didian` 是文本匹配，遇到「鼓楼区」「西湖区」这种重名地名，靠 `pro` 收窄才靠得住。

### 学名旁的「自然在线」标：这地方的名录里收了这个属的哪些种

植物类群的学名后面还有第三个标 —— 橙色的「自然在线」。跟 PPBC 一样只在植物类群下出现，
区别是它还要求站点清单里有 `xingse`（`natureOn()` 判 `activeGroup() === 'plant' && siteMeta('xingse')`）。
v1.0.48 起自然在线不再是隐藏站点，所以只要植物类群下开着它，这个标就一直在。

两者是同一套后端（`ecp.ibiodiversity.cn`）、同一张 Bearer 令牌，
点标查名录和传图识别用的是同一张牌 —— 站点开关关掉或没令牌时，标就不出现。

点它弹一个面板，按地名搜站点，列出**每个站的名录里这个属有几种**：

```
关键词「武夷山」命中 4 个站点，已查 4 个；其中 4 个站点名录里有「Rhododendron」属，
最多的是「武夷山国家公园」21 种。

▸ 武夷山国家公园    名录 3583 条 · 1245 属      21 种
    锦绣杜鹃 Rhododendron × pulchrum  腺萼马银花 R. bachii  刺毛杜鹃 R. championiae …
    建站人 陈彬 · 更新于 2026-09-30          在自然在线打开这个站 →
▸ 武夷山植物图库    名录 2210 条 ·  894 属      10 种
▸ 武夷山国家公园植物标识系统  名录 753 条 · 411 属   10 种
▸ 武夷山黄龙岩保护区  名录 1229 条 · 594 属       6 种
```

三个接口（都要 Bearer，缺令牌就报「自然在线还没登录」）：

| 用途 | 请求 | 说明 |
| --- | --- | --- |
| 搜站点 | `POST /api/online/site/channel/public/page`<br>`{ pageNum, pageSize, title }` | 中文标题模糊匹配，全站 823 个站。`id` 是拼音串（`wuyishan`），**不能拿标题当地址** |
| 取名录 | `GET /api/online/site/species/list/all/{siteId}` | 每项 `{ lname, cname, genusName, cgenusName, cfamilyName, levelName, kingdom, photoCount, nameAuthor }` |
| 看页面 | `https://ecp.ibiodiversity.cn/subsite/photoTree/{siteId}` | 只吃站点 id，深链不到某个属 |

> **必须 GET。** 同样的 `species/list/all/{id}` 用 POST 会返回 `B0001`（参数格式错误）。
> 站方前端用的就是 GET，照抄别改。

> **名录不能按属过滤、也不能分页。** 给 `list/all` 加 `genusName` / `genus` / `lname` /
> `pageNum` / `pageSize` 全都无效，永远返回整份（武夷山植物图库 2210 条 ≈ 1.2 MB）。
> 所以只能整份拉下来自己按属挑，并且必须缓存：`lib/nature.js` 按站点缓存 30 分钟（LRU 24 个站），
> 一次最多扫 12 个站（并发 4）。所以第一次查要几秒，之后点同一个站是 0ms。

实现要点：

- **关键词怎么来**：面板打开时用检索地区的地名推（`natKeyword()` / `keywordOf()` 同一套规则：
  去英文尾巴 → 取最细一级 → 去保护区 / 公园后缀 → 去行政区后缀 → 去民族名）。
  `南平市武夷山市Wuyishan City → 武夷山`、`福建省 → 福建`、`西双版纳傣族自治州 → 西双版纳`。
  「全世界（不限地区）」这种泛称直接判空，不让它去搜。面板里可以手改，改完点「查」。
- **站点 ≠ 行政区**：搜「武夷」出来 4 个站、搜「闽江源」出来 2 个站 —— 同一片山可能好几个单位
  各建了一个站，名录规模差很多（3583 / 2210 / 1229 / 753）。所以是按站列出来让人自己看，
  不汇总成一个数字。站名是文本模糊匹配，搜「南平」会混进「湖南平江芦头林场」，
  面板里明确写了这条，让人点开前看一眼站名。
- **和 PPBC 的分工**：PPBC 是全国照片墙（谁在附近拍到了什么，按拍摄地排开），
  自然在线是保护区自己编的**物种名录**（这一带认定有分布的种）。两者不一致时正好互相补。
- **只在「植物」类群下出现**，与 PPBC 同理：`Pieris` 既是粉蝶属又是马醉木属。
- **服务端只认令牌**：`/api/nature/*` 缺令牌时按「未登录」报错，不再有隐藏站点的 404 门；
  前端另有 `natureOn()` 控制显隐。
- **切类群不重绘**：跟 PPBC 一样先输出空占位 `<span class="nat-slot" data-genus>`，
  `refreshNatureChips()` 按「类群 + 站点开没开」填充或清空。
- **代码位置**：`lib/nature.js`（接口 + 缓存 + 关键词）、`server.js` 的 `/api/nature/sites`、
  `public/app.js` 的 `natureOn` / `natureSlot` / `refreshNatureChips` / `openNaturePanel`、
  `public/index.html` 的 `#nat-modal`。
- **限制**：站点名录是人工整理的，覆盖很不均（大站几千条、小站几百条），
  很多县市根本没有站 —— 搜不到不代表当地没有这个属。名录的 `levelName=Genus` 那条
  （「仅鉴定到属」）不算种，统计时已剔除。

### 学名旁的「GBIF·DS」小标：这个属在这个地区有哪些种（GBIF 取数 + DeepSeek 归纳）

点它之前先说清楚它**不是**什么：不是把「某某属在某地有哪些种」直接丢给模型。那样问，
模型会给你一份读起来很顺、物种名和分布却可能编错的清单 —— 分类学里一个错学名，比没有答案更糟。

实际顺序是反的：

1. **先向 GBIF 要实证数据**：这个属在全球有多少接受名种、该地区有记录的是哪几种、各多少条记录
   （可核查、可回溯）；
2. **中文名先去 iNaturalist 找**：拿学名精确匹配 iNat 的分类单元，取它的中文俗名；
3. **取不到的才让 DeepSeek 补**，并让它写归纳、指出明显缺漏。两处都没有就留空。

学名一律以 GBIF 返回的为准，**模型只许照抄、不许替换**；iNaturalist 已经给了中文名的，
提示词里明确标成「沿用」，模型不许改。模型额外补的种单独放在 `extra`，
界面上用「模型补充 · 未经核实」框住，和 GBIF 实证的建议分清。这样「准」和「全」分开，
谁说的哪句话一眼能看出。

面板右上角会直接报出这一份的构成：`中文名 iNaturalist 35 · DeepSeek 补 1 · 缺 5`。

面板顶部会把真正发出去的那句话原样显示出来：
`请通过 GBIF 查询 Rhododendron 属在 福建省 的全部种有哪些？`

#### 四个接口（都实测过）

| 用途 | 接口 |
|---|---|
| 属名 → usageKey | `GET /v1/species/match?name=<属>&rank=GENUS[&kingdom=Plantae]` |
| 属内接受名种**总数** | `GET /v1/species/search?highertaxonKey=<key>&rank=SPECIES&status=ACCEPTED&limit=0` |
| 单个 speciesKey → 学名 + 科 | `GET /v1/species/<key>` |
| 该地区的种 + 记录数 | `GET /v1/occurrence/search?taxonKey=<key>&country=CN[&stateProvince=…]&facet=speciesKey&facetLimit=300&limit=0` |

iNaturalist 那边只有一条：`GET https://api.inaturalist.org/v1/taxa?q=<学名>&rank=species&locale=zh-CN&all_names=true`。

#### 三条硬规矩（每条都是踩出来的）

- **同名属必须带 kingdom**。`Ficus` 既是桑科榕属又是䗉螺属、`Pieris` 既是马醉木属又是粉蝶属，
  不带界 `/species/match` 直接返回空对象（实测 `usageKey: undefined`），带上
  `kingdom=Plantae` 才有结果。所以调用方按当前识别类群传：`plant → Plantae`、
  `fungi → Fungi`、其余 `Animalia`；「通用」组不确定是哪一类，就 Plantae → Animalia → Fungi 依次试。
- **属内种列表要走 `/species/search`，不是 `/species`**。`/v1/species?highertaxonKey=…` 会无视
  `highertaxonKey`，返回 `incertae sedis / Animalia / Archaea` 这种界门级顶层节点（实测）。
  但也**不要用 `/species/search?limit=1000` 拉全属种名**：Rhododendron（1257 种）、
  Carabus（1008 种）这一步要 30 秒以上，直接撞超时，面板只剩「查询超时」。
  现在只取 `limit=0` 的**总数**，再按 speciesKey 挨个查该地区有记录的那几十个种
  （并发 8 路，实测杜鹃属 30 秒超时 → 5.5 秒，步甲属 → 1.6 秒）。
- **中国的省字段中英混着存，而且以中文为主**。同一个省能出现 `福建`(896)、`Fujian`(136)、
  `Fukien`(3)、`Fujian Sheng`(4) 这么多种写法，甚至还混着 `Kansas`、`Nebraska` 这种明显错录。
  所以 `PROV_ALIAS` 给每个省级行政区备了「中文 + 拼音 + 威妥玛」三四个别名，
  用**重复参数做 OR**（`&stateProvince=福建&stateProvince=Fujian&…`）。福建杜鹃花属：
  单独 `Fujian` 只有 14 种，合起来 40 种 —— 只写拼音会漏掉三分之二。

#### 只能筛到省，这一点必须如实说

`stateProvince` 是自由文本，市/县这一级 GBIF 没有稳定字段（`county` 同样不可靠）。
所以选了「武夷山市」，GBIF 这一层仍是按**福建省**统计的，面板里会写明
「不是只看武夷山市，市县一级请结合分布说明判断」。**不假装精确**比看起来精确重要。

境外用 `country=<ISO2>`；「全世界」不传国家。国家码只认两位 ISO ——
`WORLD` 这种不是国家码，传下去会查成空，`lib/gbifds.js` 里做了校验。

#### 实现要点

- **缓存**：地区分布按 6 小时、单个种的学名按 30 天、iNaturalist 中文名按 60 天（确认没有的
  3 天后再试），都在进程内存里。首次查一个小属约 2–3 秒，大属（杜鹃、步甲这种上千种的）
  约 5–6 秒 —— 只查该地区**有记录**的那几十个种，不再拉全属种名。之后命中缓存是 0 毫秒。
- **重试**：GBIF 对同一来源有速率限制。`getJson()` 对 429/5xx **和网络层失败**都重试
  （退避 0.6s / 1.8s），因为一次 TLS 抖动不该让整个查询白跑。
- **失败 ≠ 没有分布**：`regionFacet` 抛错时，返回值里带 `facetError`，服务端直接回
  `ok:false` 并写明「这不代表该地区没有分布」。这条是必须的 —— 把查询失败渲染成
  「0 种有记录」会让人以为这个属在当地就是没有，比报错更误导。`facetError` 时也**不叫模型**，
  否则它会顺着空数据编出一份像模像样的清单。
- **提示词约束**：`SYSTEM_PROMPT` 五条硬规矩（学名照抄、iNat 已给的标「沿用」不许改、
  只补「待补」的、`extra` 宁少不滥、只输出 JSON）；`response_format: {type:'json_object'}`、
  `temperature: 0.2`。种数多时只把记录最多的 80 种喂给模型，其余照旧显示在表里。
- **中文名对不上就留空**：`gdsCn()` 会把 `R. simsii` 这种缩写还原成首字母再比，
  比不到就显示「—」，绝不张冠李戴。
- **不挑类群**：昆虫问 `Papilio`、植物问 `Rhododendron` 都是正经问题，GBIF 动植物真菌全收，
  所以只要结果行有学名就出小标（跟 PPBC / 自然在线只认植物不同）。
- **没配 key 也能用**：GBIF 那张表照常出，iNaturalist 那部分中文名也照常拿到，
  只是没有 DeepSeek 兜底和归纳，面板顶部提示去填 key。
- **代码位置**：`lib/gbifds.js`（GBIF 检索 + 缓存 + DeepSeek 调用）、
  `server.js` 的 `/api/gbifds/query` 与 `config.deepseek`、
  `public/app.js` 的 `gbifdsSlot` / `refreshGbifdsChips` / `openGbifdsPanel` / `renderGbifds`、
  `public/index.html` 的 `#gds-modal`。

#### key 怎么存

跟站点密钥同一套：`data/config.json` 里的 `deepseek.apiKey`，Windows 下 DPAPI 加密，
只有本机本账户能解开；`/api/status` 只回 `{hasApiKey, model}`，**永远不回传 key 本身**；
设置面板里也只显示「已加密保存，不回显」。留空表示不修改，另有「清除已保存的 Key」。

#### 限制

- GBIF 是**标本与观察记录**的汇总，不是「分布名录」：某个种在当地确实有、但没人上传过记录，
  它就不会出现。记录条数反映的是采集强度，不是种群数量。
- 数据质量不均：栽培引种、鉴定误差、明显错录的省份都会混进来。DeepSeek 的总结里通常
  会点出「某几种可能是引种或误定」，但那也只是它的判断，不是核实的结论。
- `facetLimit=300`：单个属在某地超过 300 个种会被截断（国内场景几乎不会遇到）。
- 中文名由模型补写，个别种会与《中国植物志》的通行名有出入（例如 `R. championiae`
  曾被给成「毛棉杜鹃」，规范名是「刺毛杜鹃」）。**学名可信，中文名当参考**。

### 站点条怎么分组（`group` 字段）

每个 `SITE_META` 条目都带一个 `group`，前端 `TAXON_GROUPS`（`public/app.js`）按它排序分组：

| group | 显示 | 谁在里面 |
|---|---|---|
| `plant` | 植物 | 多识·植物、晓虫·植物、晓虫·月季、植物智·20k、Pl@ntNet、自然在线、百度·植物 |
| `insect` | 昆虫 | 晓虫·昆虫、文浩识蛾、文浩识蝶 |
| `bird` | 鸟类 | 多识·鸟类、快瞳·鸟、懂鸟·鸟、eBird |
| `mammal` | 兽类 | 懂鸟·兽 |
| `herp` | 两爬 | 晓虫·蛇类、懂鸟·两爬 |
| `fungi` | 菌物 | 晓虫·菌物 |
| `mollusk` | 贝类 | 晓虫·贝类 |
| `animal` | 多类群 | 多识·动物（含昆虫）、iNaturalist、百度·动物 |
| `general` | 不常用类群 | 豆包、百度·植物（以及任何忘了写 `group` 的站点） |

点类群名（`.pick-glabel[data-group]`）= 整组开关：本组全开时点一下全关（至少留一个站点），
否则整组点开（同站只取一个）。「全开/部分」的徽标按 `groupPicks()` 的代表集算——
同站互斥的模型永远凑不齐，用原始 keys 会一直显示成「部分」。
没写 `group` 的站点自动落到「通用」，所以加新站点时忘了写也不会消失。
后端只是把 `group` / `vendor` 透传给前端（`/api/status` 的 sites 里），排序与文案全在前端，改分组不用重启。

**另一种选法：`#pick-group` 下拉**（`GROUP_AUTO` + `GROUP_SELECT_ORDER`）。它不自己维护状态，
只是 `applyGroupParam(g)` 的入口（切类群 + 整组打开），选「自动（混合）」走 `applyDefaultSites()`；
反方向的同步在 `renderPicker()` 末尾的 `renderGroupSelect()`——它按 `activeGroup()` 回填下拉的值，
所以点类群名、点单个模型、选「默认」之后，下拉都会自己跟上。

### 类群互斥（`FREE_GROUP` / `SEMI_FREE_GROUP`）与站点级例外

一次只识别一个类群。前端先用 `groupConflict(a, b)` 判断两组能不能共存，再用 `sitesConflict(a, b)`
按**站点**收一层：类群冲突时，如果其中一个是 `PLANT_SAFE`（目前只有 `inaturalist`，植物也认）
就仍然算能共存。`blockedSiteOf(k)` 找出「谁挡着这个站点」，被挡的模型渲染成 `.pick.blocked`
（变灰），点它就是 `switchTaxonGroup(g, incoming)` 切过去（把真冲突的已选模型删掉）。

三条规则：

| 组合 | 能不能同时开 |
|---|---|
| 不常用类群（`FREE_GROUP = 'general'`）↔ 任何类群 | 能（豆包、百度永远不参与互斥） |
| 多类群（`SEMI_FREE_GROUP = 'animal'`）↔ 昆虫 / 鸟类 / 兽类 / 两爬 / 菌物 / 贝类 | 能 |
| 多类群 ↔ **植物** | **不能**——但 `PLANT_SAFE` 里的 iNaturalist 例外，仍能跟植物一起开 |
| 其它两个专类群之间（植物↔鸟类、昆虫↔兽类……） | 不能 |

`normalizeTaxonGroup()` 在 `loadStatus()` 里跑一次：旧缓存如果同时开了植物 + 昆虫 + 鸟类，
从选中最多的类群开始保留，**按站点**清掉真冲突的，所以「植物 + iNaturalist」「昆虫 + 多类群」
这种合规组合会完整保留，「植物 + 昆虫」只会留一个。

连带的语义变化：
- `AUTO_KEEP` 只剩一条 `duoshi`（只在 `insect` 类群自动带上，见下节）。iNaturalist 已归
  「多类群」且不再自动带。点「昆虫」时顺手把「多类群」里的多识·动物点亮——多识站方本来就把
  昆虫并进「动物」组，多一份独立判断很值；用户点掉之后写 `bioAutoOff`，不会自己回来。
- 「全选」= **当前类群 + 多类群 + 通用组**（跟当前类群冲突的不会被拉进来，比如正在植物
  就不加多类群）。不再是 21 站全开，那已经自相矛盾。
- eBird 在 `bird` 组，所以「确定地区」等于切到鸟类类群（多类群不受影响，会留着）。

### 常备模型（`AUTO_KEEP`）

「认花的人也要个通用兜底」——但兜底站点跟类群无关，不能塞进每个 `group` 里。所以前端另外
维护一张 `AUTO_KEEP` 表（`public/app.js`）：

| key | 什么时候自动带上 | 说明 |
|---|---|---|
| `inaturalist` | 任何类群 | 通用组兜底，默认常开；本地缓存里缺它时 `loadStatus()` 会补上 |
| `duoshi` | 只在 `insect` | 「多类群」里的多识·动物（多识只有 动物/植物/鸟类 三组，昆虫在动物组里）。点昆虫类群或类群下任意模型时一起点亮 |

`ensureAutoKeep(group)` 在点类群整组开（`toggleGroup`）或点单个模型（`toggleSite`）时调用：
- 若这一类群自己已经有同 `vendor` 的专用模型（点「鸟类」→ 多识·鸟类），就用专用的，不塞兜底模型
  （所以点鸟类不会把多识·动物拉进来、也不会顶掉多识·鸟类）；
- 否则 `selectSite()` 补上，提示条会说明补了谁、关了谁。

**用户能关，而且关了就记住**：手动点掉常备模型时写入 `localStorage.bioAutoOff`
（整组关掉「通用」组也一样写），之后点类群不再自动加（`loadStatus()` 也不会补 iNaturalist）；
手动点开或按「默认 / 全选」清空这份标记。所以「点昆虫默认带上多识·动物」和「用户不想带」不打架。

> 为什么不给别的类群也带上：植物跟「多类群」互斥（选它会让植物变灰）；鸟类/两爬自己就有
> 多识的专用模型；菌物/贝类拿动物模型问只会得到错答案。所以只在 `insect` 这一处默认带。

### 同站模型互斥（`vendor` 字段）

同一个网站的多个模型是「换一个候选池」，同时开只会重复投票、重复烧额度，所以 `SITE_META`
里的 `vendor` 相同即互斥：`duoshi`（动/植/鸟）、`dongniao`（鸟/兽/两爬）、`quarryman`（六个分区）、
`butterflyai`（蛾/蝶）、`baidu`（动物/植物）。前端 `selectSite()` 一旦选中某个站点就会把同 `vendor`
的其它键从 `state.selected` 里删掉，并把它们渲染成 `.pick.blocked`（变灰、虚线框，点它等于切换）；
`pickPerVendor()` 保证「全选」「点类群整组开」「读取本地缓存」都只留一个。服务端 `/api/identify`
再按 `vendor` 去重一层，防止旧缓存或直接调接口时把同一站请求两遍。

没写 `vendor` 的站点自成一家，永不互斥（iNaturalist、豆包、快瞳、eBird、植物智……）。

**多识只有三个识别分组**：`predict_group` 只接受 `general` / `plant` / `bird`
（传 `insect` 会被服务端明确拒绝：`Unsupported predict_group: insect. Expected general, plant or bird.`）。
所以「昆虫」不可能是独立站点——昆虫在 `general`（动物）组里。三个分组拆成三个站点是为了让候选池
分得开，它们**共用一份账号和同一个 cookie**（`jar: 'duoshi'`），登录只发生一次。

**文浩识蝶与识蛾是同一个引擎**：两页的 JS 都往 `/uploadbut/` 发同一份 multipart，返回的
`info[]` 只是模型给出的候选（`cat` 字段区分 moth / butterfly），换 referer 结果不变。
所以两者用 `engine: 'wenhao'` 标记，且同属 `vendor: 'butterflyai'`、只能开一个；
即便服务端真的同时收到两个键（比如老版本客户端），也只有一次是真请求，另一条按
`mirrorOf` 复用结果、合并表里只计一票。

植物智只接受 `.jpg`（扩展名不符会返回 `{"s":"0","id":"只能上传jpg图片文件"}`）：
前端会把 PNG/WebP 转成 JPEG，超过 3MB 的 JPEG 也会压到长边 2000 再发；
识别是服务端异步算的，适配器会轮询 `stuinfo` 最多 8 次等它出分。

**自然在线没有「直接传图识别」的接口**：它只提供 `identify/xingse`，入参是**相册里某张照片的
`photoId`**。所以适配器的实际链路是四步：

1. 登录换 JWT（`POST /api/online/authentication/login`，`userName`+`password`+`captcha`+`key`）
2. 把图传进一个专用相册（第一次用时自动建，标题「自然在线识别缓存（自动清理）」，私有）
3. 拿返回的 `photoId` 调 `identify/xingse`
4. `finally` 里 `POST /api/online/myNature/album/photo/deletes` 传 `[photoId]` 删掉它

所以每次识别只在对方账号里留几十毫秒的临时照片，识别完相册立刻回到 0 张。

上传那一步的参数必须和站点前端一致，缺一个都返回 `{"code":"B0001","msg":"系统执行出错"}`：

```
fileType=1        ← 数字 1，不是 "jpg"
timeZone=37       ← 数字字符串 "37"，不是 "Asia/Shanghai"
useAI=2  useBarcode=0  source=6  tz=8  fileTime=<毫秒时间戳>
albumId=<相册 uuid>  author=  deviceModel=
```

登录必须有图片验证码，程序没法自动认图，所以做成一次性人工操作：
「账号设置 → 自然在线 → 获取验证码」看图填 4 个字符 → 点「登录」。
换来的 JWT 没有有效期字段（服务端 Sa-Token 会话），一般能长期复用，**令牌与相册 ID
都写在 `config.json` 里（DPAPI 密文），浏览器侧永远拿不到明文令牌**。
失效时结果卡片会提示「令牌已失效，请在设置里重新取验证码」。

建相册要完整行政区划，否则依次报 `国家ID不能为空` → `区域ID不能为空`：

```
countryId=2013010535 区域 regionID=2013358038(华东) → provinceId=2013036373(福建省)
→ cityId=2013036374(福州市) → countyID=2013036375(鼓楼区)
```

代码位置：

```
server.js             本地 HTTP 服务 + /api/* 接口
lib/http.js           cookie 容器、带 UA/超时的 fetch
lib/adapters.js       各站点的登录与识别实现 ★改站点主要改这里
lib/parse.js          晓虫 HTML 解析、多识 JSON 解析、通用兜底解析
lib/aggregate.js      多站结果合并与排序
lib/secure.js         凭据加密（DPAPI / 本机指纹 / 内嵌密钥）
lib/seed.js           可选：本地账号种子（不含在仓库里，已被 .gitignore 排除）
tools/seal.js         生成可选的 lib/seed.js（想给自己的分发包内置账号时用）
public/               前端（原生 JS，无依赖）
data/config.json      账号密码（密文，DPAPI）
data/session.json     登录 cookie 缓存（密文，本机指纹绑定）
results/history.jsonl 每次识别的完整结果留档
```

**整个项目零依赖**，只用 Node 22 自带的 `fetch` / `FormData` / `WebSocket`。

---

## 附一、微信小程序：为什么接不了（界面入口已移除）

`生灵觅迹`、`小样方`、`形色识花`、`花伴侣拍照识花` 都是**微信小程序**：
它们的接口只在微信客户端内可用，请求要带微信下发的 `session_key` 与小程序专属签名，
没有对外的 HTTP 入口，也没法从浏览器或本地 Node 进程合法调用。

早期版本在左栏放过「复制口令」的快捷入口，后来按使用反馈去掉了——
点一次复制、还要切到微信粘贴、识别结果又回不到这个页面，实际比直接在小程序里搜更绕，
留着只是占地方。相关代码（`MINIAPPS` / `renderMiniApps`）已整体删除，
如需恢复可参照 git 历史。

若以后某个小程序推出了网页版或开放平台 API，照 `lib/adapters.js` 里现成的写法加一个
站点即可（返回 `[{ latin, cn, score, rank }]` 就会被合并逻辑直接消化）。

---

## 三、合并结果怎么算的

各站点分值口径不一样（采石工 79.4、文浩 51.2、多识 22.6、iNat 70.0 不能直接比），所以：

1. 每个站点内部先把 Top5 的置信度**归一化**（除以自身 Top5 之和，得到 0~1 权重）
2. 同一个学名跨站点累加，得到 `平均权重` 和 `被几个站点提到`
3. 综合得分 = `70% × 平均权重 + 30% × 站点支持率`，按此降序

**只有中文名怎么办**：百度动物/植物识别只回中文名、不给学名。合并因此分两遍走：
第一遍让有学名的建行、同时登记「中文名 → 行」；第二遍把只有中文名的候选按中文名
挂到已有行上（同名的并成一票），挂不上才单独建一行（学名处显示 "—"）。
这样「喜鹊」这种中文名一致的能正常合到一起，否则会被拆成两行互相压分。
（实现在 `lib/aggregate.js`：`normCn()` + 两遍循环。括号里的补充说明会在归一化时去掉。）

> 这样既不会让「只有一个站给 90 分」压过「四个站都排第一」，
> 也不会让「四个站都排在第五位」的陪跑种排到前面。
> 排序逻辑想改成更保守/更激进，改 `lib/aggregate.js` 里那行 `0.7 / 0.3` 即可。

「全站提到」= 所有参与站点都把它列进了 Top5；「3 站提到」= 3 个站点提到。
只勾选 1 个站点时，结论会标注「仅 1 个站点参与，未经交叉验证」，不会有「一致」这种假象。

---

## 四、账号设置与加密存储

页面右上角 **账号设置** 可以直接改用户名/密码，点「保存并登录」立即验证并写入
`data/config.json`。密码框**不回显**：留空表示沿用已保存的密码，填新值才会覆盖。

### 凭据的三种保存形态

所有账号密码一律不落明文，实现见 `lib/secure.js`：

| 形态 | 用在哪 | 密钥 | 特征 |
|---|---|---|---|
| `BID1.dpapi.…` | `data/config.json`（Windows） | Windows LSA（DPAPI，CurrentUser） | **只有本机本账户能解开**，文件拷到别处等于废纸 |
| `BID1.dev.…` | `data/session.json`；macOS 上的 `config.json` | 内嵌主密钥 + 本机指纹，AES-256-GCM | 与机器/账户绑定，读写 1ms 级 |
| `BID1.port.…` | `lib/seed.js`（可选的本地种子）

- 明文默认账号只存在于构建时的临时输入，**代码库里只有密文**。
- `/api/status` 与 `/api/config` 都不会把密码回传给浏览器，只返回 `hasPassword`。
- 旧版本留下的明文 `config.json` 在启动时会被自动识别、加密改写并提示一次。
- `config.json` 被拷到另一台电脑/另一个 Windows 账户时解不开，程序会打印原因并按
空白配置重建（账号需要重新填写）

### 可选：给自己的分发包内置默认账号

```bash
node tools/seal.js --out lib/seed.js '{"port":8791,"sites":{"duoshi":{"username":"…","password":"…"},"inaturalist":{"username":"…","password":"…"},"quarryman":{},"butterflyai":{},"xingse":{"username":"…","password":"…","token":"…"}}}'
node build-exe.js
```

自然在线那一项的 `token` 就是设置页登录成功后存下的 JWT（`data/config.json` 里的
`xingse.token`，用 DPAPI 解开就能看到）。把它一起打进 `seed.js`，别人拿到 exe 首次运行
就已经是登录态，不必自己输验证码；令牌失效后再让对方在设置页重登一次即可。

### 边界说明

`port` 形态的安全性来自「密钥没有以明文形式出现在文件里」，属防窥级别——程序必须能
自己解开，任何内嵌密钥的方案都挡不住完整逆向。真正需要抗逆向的落盘数据用的是 DPAPI。
另外，**拿到 exe 的人可以正常使用这些账号**，所以只发给可信的人。

---

## 五、已知限制（重要）

1. **图片会被上传到你所勾选的那些第三方站点**，涉密或未发表材料的照片请勿使用。
2. 各站点都是个人/小团队维护，**不要高频批量刷**（本项目已做排队，仍建议每次几十张以内）。
3. 解析依赖对方页面结构，**站点改版会失效**——失效时看结果卡片上的红字报错，
   改 `lib/parse.js` 对应函数即可。
4. 单张图片原图上限 20MB。**超过 16MB 的图会在浏览器里自动压一份识别用副本**
   （长边 3200 起逐级降到 10MB 以内，见 `prepareIdentifyImage()`），所以实际拖进去
   多大的照片都能识别，原图不动。
5. **多识限制图片长边 ≤640 像素**。网页界面会自动另存一张长边 640 的 JPEG 专供多识，
   其余站点仍用原图，无需手动处理；如果绕过界面直接调接口，需要自己先把图缩到 640 以内。
6. 多识已按分组拆成「多识·动物（含昆虫）/ 鸟类 / 植物」三个站点，用哪个勾哪个；
   三组共用同一份账号密码，设置页只在「多识·动物」下填写一次即可。
7. 仅监听 `127.0.0.1`，本机专用。
8. 晓虫各分区**只认自己那一类**：拿植物图去查「晓虫·昆虫」会明确报「结果页未解析到物种」，
   这不是故障；反过来它也不做跨类群兜底。全选时可以容忍这类红字卡片，合并表只统计
   真正返回了候选的站点。
9. **image.cubg.cn（国家植物图像库）的以图搜图已放弃接入**：它的接口是全站共享的
   开放配额（`异常码 18：Open api qps request limit reached`），实测连续多次都返回限流，
   无法稳定使用，因此从站点清单里移除了。
10. **自然在线必须先手工登录一次**（图片验证码机器认不了）。令牌一般长期有效，失效时
    结果卡片会写「令牌已失效」，去「账号设置 → 自然在线 → 获取验证码」重登即可。
    它在对方账号里会留一个空的「自然在线识别缓存（自动清理）」相册——**别删它**，
    删了下次识别会自动重建；相册里的照片每识别一张就删一张，正常应为 0 张。

---

## 六、批量导出

- 「导出本张 CSV」：当前图片的单站结果 + 合并结果
- 「导出全部 CSV」：队列里所有已完成的图片，适合直接并进名录表做核对

CSV 带 UTF-8 BOM，Excel 双击打开中文不乱码。

---

## 七、打包成 exe 分发

```bash
npm install --prefix .build-tools postject   # 只需一次
node build-exe.js
```

产物：`dist/物种鉴定聚合台.exe`（约 83MB，内含 Node 运行时 + 全部网页，**不含任何账号**）

**原理**：`build-exe.js` 里自带一个极简打包器，把 `lib/` 下各模块合成一个 CJS 文件、
把 `public/` 三个文件内联成字符串；再用 Node 官方 SEA 生成 blob，
最后用 `postject` 把 blob 注入 `node.exe` 的副本。

**版本号**：`node build-exe.js` 默认把补丁号 +1；也可显式指定：

```bash
node build-exe.js 1.2.0          # 指定版本
node build-exe.js --bump minor   # 1.1.3 → 1.2.0
```

**分发时给对方的文件**：只需 `物种鉴定聚合台.exe`（可附 `使用说明.txt`）。
对方双击即用，不需要装 Node。首次运行会在 exe 同级目录生成 `data/`：

```
data/config.json    你自己的账号，首次保存时写出（加密）
data/session.json   登录缓存
data/results/       识别留档 history.jsonl
```

如果 exe 放在不可写的位置（Program Files、只读 U 盘），会自动改用
`%USERPROFILE%\.bio-id-hub\data`。

**注意**：
- 账号加密保存在本机 `data/config.json`（Windows 用 DPAPI），不是仓库里带的
  能自己解开，所以拿到 exe 且会逆向的人理论上仍可还原。只发给信得过的人，别公开传播。
- exe 未做数字签名，Windows SmartScreen 会提示"未知发布者"，选"仍要运行"即可。
- 改了 `lib/` 或 `public/` 里的任何东西，都要重新 `node build-exe.js` 才会生效。

---

## 七点五、自动更新

对方装好之后，你发新版本时他们能收到提示并一键更新，不用你手动发文件。

### 为什么单文件 exe 也能自我替换

Windows 不许覆盖**正在运行**的 exe，但**允许改名**（同卷 rename 只改目录项）。
所以流程是：

1. 下载新版到 `data/update/incoming.exe`，比对 SHA-256
2. 把当前 exe 改名成 `~old-<时间戳>.exe` 让位
3. 把新版放到原名
4. 启动新进程，本进程释放端口后退出
5. 新进程启动时删掉 `~old-*`

第 2→3 步都是同卷 rename，失败还能把老文件改回来，不会出现"程序没了"。

### 配置更新源

1. 找一个能公网直链的地址（对象存储桶、自己的域名都行，**必须 https**）
2. 在项目根写 `update.json`：

```json
{ "url": "https://你的存储桶域名/bio-id-hub" }
```

3. 重新打包，地址会编译进 exe：

```bash
node build-exe.js
```

没配 `update.json` 时，exe 不检查更新，其余功能照常（"关于"里会显示「未配置更新源」）。

### 用阿里云 OSS 做更新源（推荐）

1. 注册阿里云 → 完成**个人实名认证**（支付宝授权最快）→ 开通「对象存储 OSS」
2. 创建 Bucket：名字全局唯一（如 `bioidhub-abc`），地域选离你近的（如华东1 杭州），
   存储类型「标准存储」，读写权限必须选 **公共读**，其余默认
3. 传文件：Bucket → 文件管理 → 上传文件，把 `dist/latest.json` 和
   `dist/bio-id-hub-<版本>.exe` 传到**根目录**（不要建子目录）
4. 记下根地址，形如 `https://bioidhub-abc.oss-cn-hangzhou.aliyuncs.com`，
   填进 `update.json` 的 `url`，重新打包

以后发版一条命令（需要 AccessKey，写进项目根的 `oss.config.json`）：

```bash
node build-exe.js 1.0.29        # 也可以先改 .version
node build-mac.js
node tools/publish-oss.js --with-mac --verify
```

`--with-mac` 会一起传 `latest-mac.json`、`main-<版本>.js` 和两个架构的安装包
（`bio-id-hub-mac-arm64.zip` / `-x64.zip`）。**mac 的清单文件绝不能叫 `latest.json`**——
两个平台的清单结构不同，混在一起会让对方的更新器读到错的版本。

`oss.config.json`：

```json
{
  "bucket": "bioidhub-abc",
  "region": "oss-cn-hangzhou",
  "akId": "LTAI...",
  "akSecret": "..."
}
```

> **这里用的应该是 RAM 子账号的 AK，不是主账号的 AK。** 主账号 AK 等于整个阿里云账号的
> 完全控制权，一旦泄漏（`oss.config.json` 就在 OneDrive 同步目录里）损失不可控；
> 子账号只授予这个桶的 `oss:PutObject` / `oss:GetObject` / `oss:DeleteObject` 就够发版了。
> 在 RAM 控制台建用户时勾「使用永久 AccessKey 访问」，权限策略选自定义的
> `acs:oss:*:*:<桶名>/*` 三条动作，或在 Bucket 的 RAM 授权里直接加到「读写」。
> 本机实测（`.probe/oss-ram-check.js`）：GET 清单 200、PUT 探针对象 200、DELETE 204。

不想配 AccessKey 就还走控制台拖文件，效果一样——脚本只是省点点击。
脚本会先传 exe 再传清单，中途断了也不会出现"清单指向一个还不存在的包"。

### 每次发版的发布流程

```bash
node build-exe.js                    # 产物在 dist/
# 把这两个文件传到更新源同一目录：
#   dist/bio-id-hub-<版本>.exe       ← 带版本号的副本（纯 ASCII 名，避免 URL 编码麻烦）
#   dist/latest.json                 ← 程序会请求这个
```

`latest.json` 由打包脚本自动生成，长这样：

```json
{
  "version": "1.0.6",
  "notes": "新增晓虫·鱼类分区；修复植物智大图压缩",
  "pubDate": "2026-10-24",
  "url": "bio-id-hub-1.0.6.exe",
  "size": 87323136,
  "sha256": "aadfcd8b…"
}
```

`url` 写相对文件名即可——客户端以「清单所在地址」为基准解析，
以后换存储桶或加 CDN 都不用重新打包。
`notes` 来自命令行 `--notes "..."` 或项目根的 `notes.txt`，会显示在更新提示条上。

### 对方看到的交互

- 启动约 1.5 秒后安静检查一次；有新版就在顶部出一条绿色提示条，不打断正在做的事
- 点「立即更新」→ 显示下载进度 → 替换 → 重启 → 页面自动重新加载
- 点「×」= 跳过这个版本，下次启动不再提示（换新版本会重新提示）
- 也可在「账号设置」最底下点「检查更新」手动触发

### 限制

- **别装进 `C:\Program Files`**。那里替换 exe 需要管理员权限，自动更新会失败并提示
  「程序所在目录不可写」。放 D 盘任意目录或用户目录最省事。
- 未做代码签名，更新后 SmartScreen 可能再次提示"未知发布者"，选"仍要运行"。
- 部分杀软对"程序自我替换"敏感（这是常见木马手法），可能拦截。真遇到只能加白名单。
- 更新过程要写入 exe 所在目录，如果那个目录被杀软实时监控锁住，会报 rename 失败，
  这时它不会破坏现有程序，只是更新不成功。
- macOS 版的更新逻辑见下一节：只替换 `app/main.js`（约 190 KB），清单是 `latest-mac.json`。

---

## 七点六、想知道有多少人在用（OSS 访问日志）

程序本身**不做任何使用统计**（只连 127.0.0.1、不上报）。但每次启动 1.5 秒后会去要一次
更新清单（`checkUpdate(false)`），这个请求落在 OSS 上，所以开访问日志就能粗算活跃设备。

**开通**（已做过，可重复执行，幂等）：

```bash
node tools/oss-log.js setup      # 建日志桶 bioidhub-logs + 把 bioidhub-fsw 的日志指过去
node tools/oss-log.js status     # 看当前配置与已生成的日志文件
```

日志**必须写进另一个桶**：写回源桶的话，「写日志」这个请求本身也会被记成一条日志，无限套娃。
`bioidhub-logs` 是私有桶（匿名读 403），日志前缀 `hub/`。

**统计**：

```bash
node tools/oss-log.js stats --days 7
node tools/oss-log.js stats --detail   # 再列出「每个对象被请求几次、什么状态码」，用来核对
node tools/oss-log.js selftest         # 造一份假日志验证解析，跑完自动删
```

口径：

| 日志里的请求 | 含义 |
|---|---|
| `GET latest.json`（Windows）/ `latest-mac.json`（mac） | 聚合台启动了一次（按天去重 IP ≈ 设备数） |
| `GET tagden/latest.json` / `tagden/latest-mac.json` | 标注工坊启动了一次 |
| `GET *.exe / *.zip` | 有人下载了安装包（Windows exe / mac zip） |
| `GET main-*.js` | 自动更新把更新包取走了（**不算设备**，只是升级动作） |
| `GET /?referer`、`/?logging` 之类 | 桶级操作，对象名为空，统计时自动跳过 |

**局限**（写清楚免得误读）：同一出口 IP 的多台机器算一台；换网络会重复计；只能算「设备」，
算不出「人」。日志由 OSS 每小时生成一次，刚开通要等一小时才有第一个文件。

### 踩过的两个坑（别再踩）

1. **日志不是 TSV，是 Apache 组合格式**：`IP - - [时间] "请求行" 状态 字节 ...`，字段用空格分隔、
   带引号的算一整段。最初按 TSV 写解析器，统计结果恒为 0。
2. **时间那一格 `[31/Oct/2026:22:09:29 +0800]` 内部含空格**：直接按空白切会劈成
   `[31/Oct/2026:22:09:29` 和 `+0800]` 两个 token，后面所有下标整体错位一格 —— 请求行跑到 `[5]`
   而不是 `[4]`，于是每行都在「匹配请求行」那步被丢掉，统计还是 0。正确做法：先用
   `/\[([^\]]+)\]/` 把方括号时间整段摘掉，再切剩下的（切完 `[0]` IP、`[3]` 请求行、`[4]` 状态码）。
   两次都是同样的表现（「0 条请求」），`selftest` 就是为了让这类静默错误立刻现形。

**第一次真实读数**（日志从 2026-10-31 22:00 开始产生）：10-31 · 11-01 两天里，
聚合台 2 台不同 IP、标注工坊 1 台不同 IP —— 其中包含自己发布时 curl 复核用的这台机器，
也就是说**还没有第三方用过**，与预期一致。

---

## 七点七、清理 OSS 上的旧版本

每发一版都会多留一个 exe（约 84 MB）和一个 mac 的 `main-*.js`。攒十几个版本就是 1 GB 多，
但**不能按后缀乱删** —— 见下面的坑。

```bash
node tools/oss-clean.js                              # 只报告：删什么、留什么、哪些拿不准
node tools/oss-clean.js --apply                      # 真的删（删完自动复查关键文件是否还能下载）
node tools/oss-clean.js --apply --rm "某个键"        # 顺手删掉「拿不准」里的某一个
```

判定规则（宁可不删，不能删错）：

| 分类 | 谁 | 处理 |
|---|---|---|
| 清单 | `latest.json`、`latest-mac.json`、`tagden/latest*.json` | 保留 |
| **清单点名的文件** | `latest.json.url` = `bio-id-hub-1.0.49.exe`；`latest-mac.json.url` = `main-1.0.49.js` | 保留 |
| 固定别名 | `bio-id-hub-win.exe`、`tagden/tagden-win.exe`（群发文案里的短链接） | 保留 |
| mac 安装包 | `bio-id-hub-mac-{arm64,x64}.zip`、`tagden/tagden-mac-*.zip` | 保留 |
| 版本号比当前低的 `xxx-1.2.3.exe` / `main-1.2.3.js` | 旧版本 | 删除 |
| 认不出来的名字 | 例如早期手动传的 `物种鉴定聚合台-mac-arm64.zip` | 只列出，要删得 `--rm` 点名 |

**坑：`latest.json` 的 url 是带版本号的那个 exe，不是别名。** 所以「删掉所有 `bio-id-hub-*.exe`」
会直接把自动更新打成 404。脚本按清单解析当前版本，只删比它低的那些；删完还会 HEAD 一遍
清单、别名、安装包，确认 `9/9` 仍是 200。

2026-11-01 第一次清理：删 27 个对象回收 1.29 GB，桶里从 41 个降到 14 个（482.8 MB）。
**同时确认早年的「删旧版本」其实一直没生效** —— 请求路径多写了一层桶名（`bucket/key`），
OSS 对不存在的对象也回 `204`，所以看着成功。要确认删除是否真的生效，必须删完再列一次。

本地同类清理（都不影响程序，删了会自动重建）：
| 路径 | 说明 |
|---|---|
| `dist-mac/物种鉴定聚合台-mac-{arm64,x64}/` | 打 zip 前的解包目录，含 node 二进制（各 109 MB）；`build-mac.js` 每次先 `rmSync` 再重建 |
| `dist-mac/~check-main.js` | 构建时的临时校验副本，正常流程会自己删掉，异常中断才留下 |
| `dist/.~write-test-*` | 上传前写权限测试的 0 字节残留 |
| `.probe/` | 各站点接口的调试记录（小文件留着无妨，里面的旧 exe 备份可删） |
| `.cache/` | **不要删** —— mac 版用的 node 运行时压缩包，删了下次构建要重新下载 |

---

## 七点八、形色 / 版纳园：为什么接不了，怎么才能接

这两家都**没有公开 API**，跟 PlantNet、iNaturalist 那种拿 Key 就能调的不一样。查过的情况：

| 服务 | 现状 | 卡在哪 |
|---|---|---|
| 自然在线（原「形色」，`ecp.ibiodiversity.cn`） | **已接入**，走「账号 + 图片验证码」登录换令牌 | 验证码只能人工看，令牌过期要重登。它的 App 域名 `api.xingseapp.com` 在本机根本连不上，没有可用的网页版接口 |
| 版纳园（西双版纳热带植物园科技信息中心，`image.cubg.cn:9092/ai/cubg_st`） | 服务还活着，而且是**跨类群**的（动植物真菌都认，回科属种 + 支持率） | ① 2018 年那个试用 token 早过期，现在一律回 `{"code":400,"msg":"Invalid request"}`；② 它**只收图片 URL、不收上传**，本机照片得先放到公网能访问的地方 |

两条路要走通，都得先拿到「一次真实请求」长什么样：

**怎么抓（在电脑上最省事）**

1. 装 Fiddler Classic（Windows 免费）。`Tools → Options → HTTPS` 勾上
   `Capture HTTPS CONNECTs` 与 `Decrypt HTTPS traffic`，按提示装并信任根证书；
   `Connections` 里记下端口（默认 8888）。
2. 打开**电脑版微信**，进那个小程序（形色识花 / 版纳园识图），点一次「拍照识别」。
3. 在 Fiddler 里按 `api` 或域名过滤，找到上传/识别那条请求，右键 `Copy → Just Url`、
   `Save → Request → Entire Request`（要 URL + 请求头 + 请求体），再把对应的 **Response 正文**存一份。
4. 把这几样发过来就行 —— 照它写适配器，一般一次就能通。

**抓的时候注意**：只抓自己账号、自己这张图；接口是对方的服务，自己拍照识别没问题，
别拿去批量刷或转卖。

拿到之后各自还差一步：

- **自然在线 / 形色**：如果小程序那条是免验证码的（比如只带一个固定 appid + 签名），
  就做成 `auth: 'key'` 的新站点，填一次长期用；如果它也要 wx.login 的 code，那还是走现在的登录流程。
- **版纳园**：除了 token，还得解决「图片要公网 URL」。可行做法是识别时把这张图临时传到
  `bioidhub-fsw` 的私有子路径 → 拼一个带签名的 URL 给它 → 调完立刻删（和现在自然在线
  「传相册 → 识别 → 删图」一个思路）。这步要等 token 到手再做，否则写了也没法验证。

---

## 八、打包成 macOS 版

```bash
node build-mac.js               # 同时出 arm64（M 系列）和 x64（Intel），版本号取 .version
node build-mac.js --arch arm64  # 只出 M 芯片那一份
node build-mac.js 1.0.18        # 指定版本号（不指定就用 .version，mac 不会自动 +1）
node build-mac.js --notes "改了啥"
```

产物（`dist-mac/`）：

| 文件 | 用途 |
|---|---|
| `物种鉴定聚合台-mac-arm64.zip`（约 36 MB） | 首次安装用，M1~M4 芯片。默认只构建这一份 |
| `物种鉴定聚合台-mac-x64.zip`（约 37 MB） | 首次安装用，老 Intel Mac。**按需构建**：`node build-mac.js --arch x64`，产物不常备（省 150 MB） |
| `main-<版本>.js`（约 190 KB） | 自动更新的替换包，**两个架构共用一份** |
| `latest-mac.json` | mac 的更新清单（和 exe 的 `latest.json` 分开放） |

解压后是一个文件夹：

```
start.command     0755  双击启动（终端里会打印日志）
node              0755  官方 node 运行时，一个字节都没改，签名继续有效
app/main.js       0644  打包后的程序（网页已内联，与 exe 里那份同源）
使用说明.txt       0644  给接收方看的说明
```

**为什么不像 exe 那样注入 SEA**：苹果要求每个可执行文件都有签名，而注入字节会把
node 官方的签名弄坏，重新签名（`codesign`）只能在 macOS 上做。在 Windows 上交叉
构建出来的注入版，到 Mac 上会被系统直接杀掉。改成「原装运行时 + 旁边放代码」，
在 Windows 上构建也能保证签名链完整。

**几个实现细节**（都在 `build/` 下，无第三方依赖）：
- `build/bundle.js` —— 与 exe 共用的打包器，输出同一份 `main.js`
- `build/tar.js` —— 自己解析 tar.gz 取出 `bin/node`。Windows 的 GNU tar 会把
  `C:\` 当成远程主机名，用不了
- `build/zip.js` —— 自己写 zip。Windows 自带压缩会丢掉 Unix 权限位，解压到 macOS
  后 `node` 和 `start.command` 就没有执行权限；这里显式写入 `mode << 16`，
  并给中文文件名打 UTF-8 标记
- 运行时路径：`app/main.js` 的上一级即安装根目录，`data/` 落在那里；不可写则回退到
  `~/.bio-id-hub/data`

**接收方怎么用**：解压 → 双击 `start.command`。首次可能被 Gatekeeper 拦一次，
用「右键 → 打开」放行，或在终端执行 `xattr -dr com.apple.quarantine <解压出的文件夹>`。

**macOS 上的加密差异**：系统没有 DPAPI，`config.json` 用的是 `dev` 形态
（AES-256-GCM，密钥 = 内嵌主密钥 + 本机指纹），强度低于 Windows 的 DPAPI，
仍属「防窥」级别，换机器解不开。
- 端口固定 8791；重复双击时第二个实例检测到端口占用，会直接把浏览器开起来然后退出。

### 八之一、macOS 的自动更新怎么实现的

和 exe 差一件事：**换的东西不一样**。

| | Windows exe 版 | macOS 目录版 |
|---|---|---|
| 清单 | `latest.json` | `latest-mac.json` |
| 待装包 | `data/update/incoming.exe` | `data/update/incoming.js` |
| 替换目标 | 程序自身的 exe | `app/main.js` |
| 包大小 | 80+ MB | 约 190 KB，几秒下完 |
| 重启方式 | `spawn(新 exe)` | `spawn(同一个 node, [新 main.js])` |

为什么能在线替换：POSIX 下 `rename` 覆盖目标是原子的，而正在运行的进程持有的是
旧 inode，替换文件不会影响它的执行；替换完 spawn 一个新的 node 跑新 `main.js`，
老进程 2.5 秒后退出（这段时间新进程已经在重试抢端口）。

为什么不用 `codesign`：`node` 运行时和 `start.command` **完全不动**，更新的只是
纯 JS 文件，所以官方签名一直有效 —— 不会出现更新后「无法验证开发者」打不开的情况。
这也是 mac 版坚持用「目录 + 原装 node」而不是 SEA 注入的根本原因。

启动时 `lib/env.js` 用 `process.argv[1]` 是否匹配 `<...>/app/main.js` 判定形态
（`isAppBundle`），`lib/updater.js` 据此选清单名、待装包名、替换目标和重启参数；
`/api/status` 里的 `mode` 字段（`exe` / `bundle` / `source`）就是给前端显示用的。

### 八之二、mac 版怎么发

```bash
node build-exe.js --notes "这次的改动"     # 先发 Windows，会把 .version +1
node build-mac.js --notes "这次的改动"     # mac 用同一个版本号
```

然后把下面三样传到 OSS **根目录**（和 `latest.json`、exe 放在一起）：

```
dist-mac/物种鉴定聚合台-mac-arm64.zip    ← 首次安装包（M 芯片），给新用户下载
dist-mac/main-<版本>.js                  ← 自动更新包，老用户点更新时下这个
dist-mac/latest-mac.json                 ← mac 的更新清单
```

`latest-mac.json` 长这样（打包脚本自动生成）：

```json
{
  "version": "1.0.17",
  "notes": "首次发布 macOS 版…",
  "app": "mac",
  "url": "main-1.0.17.js",
  "size": 192109,
  "sha256": "3bb760bb…",
  "pubDate": "2026-10-26"
}
```

注意：**mac 的清单名不能叫 `latest.json`**，否则 Windows 用户会拿到一个 `main-*.js`
当成 exe 去替换，反之亦然。代码里按打包形态自动选，两个文件互不干扰。

⚠️ 别把整个文件夹放进「应用程序」(`/Applications`)：普通用户没有写权限，
自动更新会失败（界面提示「程序所在目录不可写」）。桌面、下载、文稿都行。
