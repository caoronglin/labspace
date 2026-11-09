import type { ServiceItem } from '../services/api';

/**
 * 服务目录里不少条目的 URL 已经指向门户站内页面（/bioinfo、/genomes 等）。
 * 这类条目不应该再经过「服务详情」这一层，否则同一个功能出现两个入口。
 */
export function nativeRouteOf(service?: Pick<ServiceItem, 'url'> | null): string | null {
  const url = (service?.url || '').trim();
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  if (url.startsWith('/services')) return null;
  return url;
}

/** 服务卡片的跳转目标：站内页面直达，其余走服务详情。 */
export function serviceTarget(service: Pick<ServiceItem, 'id' | 'url'>): string {
  return nativeRouteOf(service) ?? `/services/${service.id}`;
}
