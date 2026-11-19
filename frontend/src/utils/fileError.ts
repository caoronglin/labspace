/**
 * 文件操作的错误文案翻译（Go 核心返回英文，界面需要中文）。
 *
 * 单独成模块的原因：`Files.tsx` 与 `useFileUpload` 都要用同一套翻译，
 * 复制两份必然会漂移（改了一处忘了另一处，用户会看到两种说法）。
 */

/** 把 Go 核心的英文拒绝原因翻译成界面用语，避免只剩一个裸状态码。 */
export function fileErrorText(raw: string): string {
  const table: [RegExp, string][] = [
    [/permission denied/i, '当前账号没有该目录的写入权限'],
    [
      /storage rejected the write/i,
      '存储层拒绝了写入（目录权限或只读挂载），请联系管理员处理',
    ],
    [/file writes require a user identity/i, '需要以个人账号登录后才能管理文件'],
    [/resource already exists/i, '同名文件已存在'],
    [/resource not found/i, '文件已被移动或删除，请刷新列表'],
    [/invalid path or name/i, '名称或路径不合法'],
    [/exceeds the size limit/i, '文件超过大小上限'],
    [/cannot preview a directory/i, '文件夹不能预览'],
    [/cannot download a directory/i, '文件夹不能直接下载'],
    [/trash manifest/i, '回收站清单读写异常，请联系管理员处理'],
    [
      /data moved to/i,
      '文件已移入回收站但清单未记账成功，请联系管理员核对回收目录',
    ],
  ];
  for (const [re, zh] of table) if (re.test(raw)) return `${zh}（${raw}）`;
  return raw;
}
