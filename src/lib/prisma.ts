import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

// 开发环境下复用实例，避免 Next.js 热重载时创建过多连接
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
