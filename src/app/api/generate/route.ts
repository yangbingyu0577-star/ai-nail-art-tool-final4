import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_CONSTRUCTION_LIST } from '@/lib/constructionList';
import type { ConstructionList } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ARK_API_KEY = process.env.ARK_API_KEY;
const VOLC_ENDPOINT_ID = process.env.VOLC_ENDPOINT_ID;

const ARK_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

function extractBase64FromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
  return match ? match[1] : dataUrl;
}

async function urlToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法获取图片: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

function buildPrompt(instruction: string): string {
  const base = 'beautiful nail art design on human hand, professional manicure, close-up photo, high quality, detailed';
  const userReq = instruction || '精美美甲设计';
  return `${base}, ${userReq}`;
}

async function generateNailImageWithArk(
  base64Image: string,
  prompt: string
): Promise<string> {
  if (!ARK_API_KEY || !VOLC_ENDPOINT_ID) {
    throw new Error('未配置火山方舟 API Key 或模型接入点 ID，请设置 ARK_API_KEY 和 VOLC_ENDPOINT_ID 环境变量');
  }

  const imageParam = `data:image/png;base64,${base64Image}`;

  const response = await fetch(ARK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ARK_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOLC_ENDPOINT_ID,
      prompt,
      image: imageParam,
      response_format: 'url',
    }),
  });

  if (!response.ok) {
    let errDetail = '';
    try {
      const errBody = await response.json();
      errDetail = errBody?.error?.message || errBody?.error?.code || '';
    } catch {
      errDetail = await response.text().catch(() => '');
    }
    console.error('[Ark API Error]', response.status, errDetail);
    const friendlyMsg = response.status === 401
      ? 'API Key 无效或已过期'
      : response.status === 403
      ? '无权限调用该模型，请检查接入点 ID'
      : response.status === 429
      ? '调用频率超限，请稍后重试'
      : `火山方舟API调用失败: ${response.status}`;
    throw new Error(friendlyMsg);
  }

  const data = await response.json();
  const imageUrl: string | undefined = data?.data?.[0]?.url;

  if (!imageUrl) {
    throw new Error('火山方舟API未返回图片URL');
  }

  return imageUrl;
}

async function saveToKV(record: {
  instruction: string;
  imageUrl: string;
  timestamp: string;
}): Promise<void> {
  try {
    const kv = await import('@vercel/kv');
    const id = `design:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await kv.kv.set(id, JSON.stringify(record));
    await kv.kv.lpush('designs:list', id);
  } catch (e) {
    console.error('[KV Save Error]', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const images: string[] = body.images || [];
    const instruction: string = body.instruction || '精美美甲设计';

    if (images.length === 0) {
      return NextResponse.json(
        { success: false, error: '请至少上传一张素材图片' },
        { status: 400 }
      );
    }

    const firstImage = images[0];
    let base64Image: string;
    try {
      if (firstImage.startsWith('data:')) {
        base64Image = extractBase64FromDataUrl(firstImage);
      } else {
        base64Image = await urlToBase64(firstImage);
      }
    } catch (err) {
      console.error('[Image extraction failed]', err);
      return NextResponse.json(
        { success: false, error: '图片处理失败，请重新上传' },
        { status: 400 }
      );
    }

    // Step 1: Generate nail art image with Ark (Volcengine) image-to-image API
    const prompt = buildPrompt(instruction);
    let imageUrl: string;
    try {
      imageUrl = await generateNailImageWithArk(base64Image, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '图像生成失败';
      return NextResponse.json(
        { success: false, error: msg },
        { status: 500 }
      );
    }

    // Step 2: Save record to Vercel KV
    const timestamp = new Date().toISOString();
    await saveToKV({
      instruction,
      imageUrl,
      timestamp,
    });

    // Step 3: Return result with default construction list
    return NextResponse.json({
      success: true,
      imageUrl,
      constructionList: DEFAULT_CONSTRUCTION_LIST,
      instruction,
      timestamp,
    });
  } catch (error) {
    console.error('[Generate Route Error]', error);
    const msg = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json(
      { success: false, error: `生成失败: ${msg}` },
      { status: 500 }
    );
  }
}
