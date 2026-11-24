/**
 * 文件展示元信息：图标 / 大小 / 时间 / 可在线编辑的扩展名。
 *
 * 文件页（Files.tsx）与时间线视图（TimelineView.tsx）共用同一份判定，
 * 避免两处各维护一套扩展名表，久而久之图标与"能不能编辑"就对不上了。
 */
import type { ReactNode } from 'react';
import {
  CodeOutlined,
  ExperimentOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileZipOutlined,
  FolderOpenOutlined,
  SoundOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';

import { formatDateTime, formatSize } from '../../utils/format';
export type FileVisual = { icon: ReactNode; color: string };

const GENOME_EXTS = new Set(['fa', 'fna', 'fasta', 'fas', 'ffn', 'frn', 'faa', 'gff', 'gff3', 'gtf', 'bed', 'vcf']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic']);
const ARCHIVE_EXTS = new Set(['zip', 'gz', 'bz2', 'xz', 'tar', 'tgz', '7z', 'rar']);
const SHEET_EXTS = new Set(['xls', 'xlsx', 'csv', 'tsv']);
const DOC_EXTS = new Set(['doc', 'docx', 'rtf', 'odt']);
const PPT_EXTS = new Set(['ppt', 'pptx', 'odp']);
const TEXT_EXTS = new Set(['md', 'txt', 'rst', 'log', 'tex']);
const CODE_EXTS = new Set([
  'py', 'js', 'ts', 'tsx', 'jsx', 'go', 'rs', 'sh', 'bash', 'json', 'yaml', 'yml',
  'toml', 'c', 'cpp', 'h', 'hpp', 'java', 'r', 'sql', 'html', 'css',
]);
// 与 Go preview.codeLang 对齐的源码扩展名；json/yaml 等文本配置不走源码预览。
const SOURCE_CODE_EXTS = new Set([
  'py', 'ipynb', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1',
  'sql', 'css', 'scss', 'html', 'vue', 'toml', 'ini', 'cfg', 'conf',
  'dockerfile', 'mk', 'lua', 'r', 'pl', 'kt', 'swift', 'scala',
]);
const SOURCE_CODE_NAMES = new Set(['dockerfile', 'makefile', 'cmakelists.txt', 'pyproject.toml']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a']);
const BIO_EXTS = new Set([...GENOME_EXTS, 'fastq', 'fq', 'bam', 'sam', 'pdb', 'gb', 'gbk', 'genbank']);

/**
 * 可在线编辑的纯文本扩展名。
 *
 * 只放"纯文本"：图片、压缩包、Office 文档等二进制文件走既有预览/编辑通道，
 * 在文件菜单里不显示"在线编辑"，避免用户点进去只拿到乱码。
 */
const TEXT_EDITABLE_EXTS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'tex', 'bib',
  'py', 'js', 'ts', 'sh', 'conf', 'ini', 'toml', 'log',
]);

export function extOf(name: string): string {
  const parts = name.split('.');
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : '';
}

export function fileVisual(name: string, dir: boolean): FileVisual {
  if (dir) return { icon: <FolderOpenOutlined />, color: '#D97706' };
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return { icon: <FileImageOutlined />, color: '#7C3AED' };
  if (ext === 'pdf') return { icon: <FilePdfOutlined />, color: '#DC2626' };
  if (SHEET_EXTS.has(ext)) return { icon: <FileExcelOutlined />, color: '#16A34A' };
  if (PPT_EXTS.has(ext)) return { icon: <FilePptOutlined />, color: '#EA580C' };
  if (DOC_EXTS.has(ext)) return { icon: <FileWordOutlined />, color: '#2563EB' };
  if (ARCHIVE_EXTS.has(ext)) return { icon: <FileZipOutlined />, color: '#CA8A04' };
  if (TEXT_EXTS.has(ext)) return { icon: <FileTextOutlined />, color: '#0891B2' };
  if (CODE_EXTS.has(ext)) return { icon: <CodeOutlined />, color: '#4F46E5' };
  if (BIO_EXTS.has(ext)) return { icon: <ExperimentOutlined />, color: '#059669' };
  if (VIDEO_EXTS.has(ext)) return { icon: <VideoCameraOutlined />, color: '#DB2777' };
  if (AUDIO_EXTS.has(ext)) return { icon: <SoundOutlined />, color: '#EA580C' };
  return { icon: <FileOutlined />, color: '#64748B' };
}

/** 是否为可在线编辑的纯文本文件（无扩展名的文件不算）。 */
export function isTextEditable(name: string): boolean {
  const ext = extOf(name);
  if (!ext) return false;
  return TEXT_EDITABLE_EXTS.has(ext);
}

/** 是否为源码文件：门户原生代码预览（行号 / 换行 / 复制 / 分段渲染）优先。 */
export function isCodeFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SOURCE_CODE_NAMES.has(lower) || SOURCE_CODE_EXTS.has(extOf(lower));
}

/** 是否为图片（有缩略图）。 */
export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

/** 是否为基因组序列文件。 */
export function isGenomeFile(name: string): boolean {
  return GENOME_EXTS.has(extOf(name));
}

// 兼容旧名：统一实现后仍按原名导出，调用方不用改。
export { formatSize, formatDateTime as formatTime };
