import type { ComponentType } from 'react';
import type { OfficeContent } from '../../services/api';
import DocxEditor from './DocxEditor';
import XlsxEditor from './XlsxEditor';
import PptxEditor from './PptxEditor';
import PptPresentation from './PptPresentation';

export type OfficeEditorProps = {
  entryId: string;
  data: OfficeContent;
  onSaved: () => void;
};

export type OfficePresentationProps = {
  entryId: string;
  name: string;
  open: boolean;
  slides?: OfficeContent['slides'];
  onClose: () => void;
};

export type OfficeAdapter = {
  kind: OfficeContent['kind'];
  extensions: string[];
  label: string;
  Editor: ComponentType<OfficeEditorProps>;
  /** 仅演示文稿注册放映组件；其它 Office 类型没有该入口。 */
  Presentation?: ComponentType<OfficePresentationProps>;
};

/**
 * Office 组件注册表：文件存储只认扩展名，不关心具体是 Word/Excel/PPT。
 * 新增格式时在这里注册一个适配器即可，预览/编辑/放映入口自动出现。
 */
const ADAPTERS: OfficeAdapter[] = [
  {
    kind: 'docx',
    extensions: ['docx', 'doc'],
    label: 'Word 文档',
    Editor: DocxEditor,
  },
  {
    kind: 'xlsx',
    extensions: ['xlsx', 'xls'],
    label: 'Excel 工作簿',
    Editor: XlsxEditor,
  },
  {
    kind: 'pptx',
    extensions: ['pptx', 'ppt'],
    label: 'PowerPoint 演示文稿',
    Editor: PptxEditor,
    Presentation: PptPresentation,
  },
];

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function officeAdapterFor(name: string): OfficeAdapter | null {
  const ext = extOf(name);
  return ADAPTERS.find((a) => a.extensions.includes(ext)) ?? null;
}

export function isOfficeEditable(name: string): boolean {
  return officeAdapterFor(name) !== null;
}

export function hasPresentation(name: string): boolean {
  return Boolean(officeAdapterFor(name)?.Presentation);
}

export const OFFICE_EXTENSIONS = ADAPTERS.flatMap((a) => a.extensions);
