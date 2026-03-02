# Video HLS Host (Pages)

用于把本地 FFmpeg 切好的 `m3u8 + ts` 托管到 Cloudflare Pages，并用短路径访问。

## 目录结构

```txt
public/
  _v/
    001/
      index.m3u8
      000.ts
      001.ts
    shhd/
      index.m3u8
      000.ts
      001.ts
  _headers
  _redirects   # 自动生成
  player.html  # 可选，人类直接打开观看
scripts/
  gen-redirects.mjs
```

## 使用方式

1. 把每个视频放进 `public/_v/<slug>/`
2. 保证每个目录里有 `index.m3u8`
3. 运行：

```bash
npm run gen:redirects
```

会自动生成短路径映射：

- `/001 -> /_v/001/index.m3u8`
- `/shhd -> /_v/shhd/index.m3u8`

## Cloudflare Pages 配置

- Build command: `npm run build`
- Build output directory: `public`
- Custom domain: `v.kyr.us.ci`

## 访问示例

- 清单短路径：`https://v.kyr.us.ci/001`
- 播放器页面：`https://v.kyr.us.ci/player.html?v=001`

