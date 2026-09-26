/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // 部署时不要暴露框架版本号（省一次无谓的信息泄露）
  poweredByHeader: false,

  experimental: {
    // 论文上传走 Server Action，PDF 可能较大，这里放宽 body 上限。
    // 注意要和解析服务的 PARSER_MAX_UPLOAD_MB 保持一致，
    // 否则会出现「Next 收下了、Parser 拒收」的割裂体验。
    serverActions: {
      bodySizeLimit: '50mb',
      /**
       * Server Action 的 Origin 白名单（部署必需）。
       *
       * 为什么必须显式配置：
       *   Next.js 对 Server Action 请求做 CSRF 防护 —— 会校验请求的
       *   Origin 是否可信。默认白名单**只包含 localhost**（以及已配置的
       *   `experimental.serverActions` 推导值），于是通过反代域名访问时
       *   所有 Server Action 一律被拒，页面直接抛
       *   "Invalid Server Actions request" 变成 Application error。
       *   本地 curl 首页却是 200，极易误判为"部署成功"。
       *
       * 取值形态（Next 14.2 的硬约束，踩过坑）：
       *   这里**必须是字符串数组**，写成函数会得到
       *   `Expected array, received function`，
       *   并且在渲染期崩成 `TypeError: t.some is not a function` ——
       *   比不配置还糟。所以下面用数组 + 环境变量拼接。
       *
       * 域名来源：
       *   `NEXT_PUBLIC_APP_ORIGIN` 由发布时注入分享域名；未设置时
       *   退回本地地址。这样换环境不用改代码。
       */
      allowedOrigins: [
        'localhost:3000',
        '127.0.0.1:3000',
        ...(process.env.NEXT_PUBLIC_APP_ORIGIN
          ? [process.env.NEXT_PUBLIC_APP_ORIGIN.replace(/^https?:\/\//, '')]
          : []),
        // 平台分享域名的通配兜底：Next 支持 `*.host` 形式的通配。
        // 只放行平台自己的域名，不是无条件放开。
        ...(process.env.NEXT_PUBLIC_APP_ORIGIN_WILDCARD
          ? [process.env.NEXT_PUBLIC_APP_ORIGIN_WILDCARD]
          : []),
      ],
    },
  },

  // 打印一条启动提示：把两个最容易踩的部署坑直接写在这里，
  // 免得用户翻文档 —— 真正出问题时人往往不会去读 README。
  webpack: (config, { isServer }) => {
    if (isServer && process.env.NODE_ENV === 'production') {
      const url = process.env.DATABASE_URL || ''
      if (url.startsWith('file:./')) {
        console.log(
          '\n  \x1b[33m[提示]\x1b[0m DATABASE_URL 是相对路径，' +
            'Prisma 会相对 prisma/schema.prisma 解析（即 prisma/dev.db）。\n' +
            '         若换目录启动后看不到数据，请改成绝对路径，' +
            '例如 file:/var/lib/methodatlas/dev.db\n'
        )
      }
      if (process.env.ENABLE_PIPELINE_API === '1') {
        console.log(
          '\n  \x1b[33m[警告]\x1b[0m ENABLE_PIPELINE_API=1：' +
            '演示数据接口 /api/pipeline 已开启（无鉴权）。\n' +
            '         请勿在公网部署中保持开启。\n'
        )
      }
    }
    return config
  },
}

export default nextConfig
