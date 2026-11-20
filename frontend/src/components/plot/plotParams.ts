import type { PlotChart } from '../../services/api';
import { parseTable } from './plotTable';

/**
 * 表单初值：checkbox 关、number 空、select 取第一项。
 *
 * 传了 `dataText` 时，文本类参数顺手认领同名列（`x`/`y`/`group` 这种列名与参数同名的模板
 * 一选模板就能出图）；示例数据带自己的 `params`，所以不传 `dataText`，避免先猜再被覆盖。
 */
export function defaultParams(chart: PlotChart | undefined, dataText?: string): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  if (!chart) return init;
  const headers = dataText === undefined ? undefined : parseTable(dataText).headers;
  chart.params.forEach((spec) => {
    if (spec.type === 'checkbox') init[spec.key] = false;
    else if (spec.type === 'number') init[spec.key] = undefined;
    else if (spec.type === 'select') init[spec.key] = spec.options?.[0];
    else if (headers) init[spec.key] = headers.includes(spec.key) ? spec.key : undefined;
  });
  return init;
}

/** 提交参数：去掉空值，再补上色板 / 尺寸 / 从「配色搭配」带来的颜色。 */
export function payloadParams(
  values: Record<string, unknown>,
  style: { palette: string; width: number; height: number; customColors: string[] },
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  Object.entries(values).forEach(([k, v]) => {
    if (v === undefined || v === '' || v === null) return;
    clean[k] = v;
  });
  clean.palette = style.palette;
  clean.width = style.width;
  clean.height = style.height;
  if (style.customColors.length) clean.colors = style.customColors;
  return clean;
}
