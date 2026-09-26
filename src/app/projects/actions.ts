'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'

/**
 * 创建项目
 * P1 成功标准 #1：用户可以创建一个 Project
 */
export async function createProject(formData: FormData) {
  const name = String(formData.get('name') || '').trim()
  if (!name) return

  const description = String(formData.get('description') || '').trim()

  await prisma.project.create({
    data: {
      name,
      description: description || null,
    },
  })

  revalidatePath('/projects')
}
