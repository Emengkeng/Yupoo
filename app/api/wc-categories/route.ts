import { NextResponse } from 'next/server';
import { getAllCategories } from '@/lib/woocommerce';

export async function GET() {
  try {
    const cats = await getAllCategories();
    return NextResponse.json({ ok: true, categories: cats });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch categories';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
