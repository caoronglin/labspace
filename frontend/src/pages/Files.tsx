import PageShell from '../components/PageShell';
import OfficeWorkspace from '../components/office/OfficeWorkspace';
import TextEditorModal from '../components/files/TextEditorModal';
import { useFilesState } from './files/useFilesState';
import {
  deleteActions,
  rowMenus,
  selectionActions,
  shareActions,
  type FilesDeps,
} from './files/actions';
import { renderFilterCard, renderToolbar, renderUploadAlerts } from './files/toolbar';
import { renderListCard } from './files/views';
import {
  renderAuditModal,
  renderManageModal,
  renderMoveModal,
  renderNameDialog,
  renderNewFileDialog,
  renderPreviewModal,
  renderShareModal,
  renderTrashModal,
} from './files/modals';

/**
 * 文件共享页。
 *
 * 原本 2700+ 行的巨石已按职责拆分（行为不变，全部代码原样搬移）：
 * - 状态与查询：./files/useFilesState（自定义 hook）
 * - 共享/删除/入库/移动等操作闭包：./files/actions
 * - 展示小组件与纯函数：./files/presenters
 * - 顶栏/筛选卡/上传进度：./files/toolbar
 * - 列表/网格/详情/时间线视图：./files/views
 * - 各弹窗：./files/modals
 */
export default function Files() {
  const state = useFilesState();
  const { message, refreshAll, officeTarget, setOfficeTarget, textEditTarget, setTextEditTarget } = state;
  const shareFns = shareActions(state);
  const deleteFns = deleteActions(state);
  const selectionFns = selectionActions(state);
  const deps = { ...state, ...shareFns, ...deleteFns, ...selectionFns };
  const { rowMenu, rowActions } = rowMenus(deps);
  const ui: FilesDeps = { ...deps, rowMenu, rowActions };
  return (
    <PageShell
      title="文件共享"
      description="公共资料、质粒与基因组按用户组授权共享；个人文件默认私密，可单独指定共享人。"
      extra={renderToolbar(ui)}
    >
      {renderFilterCard(ui)}
      {renderUploadAlerts(ui)}
      {renderListCard(ui)}
      {renderMoveModal(ui)}
      {renderPreviewModal(ui)}
      <OfficeWorkspace
        entry={officeTarget?.entry ?? null}
        mode={officeTarget?.mode ?? 'edit'}
        open={Boolean(officeTarget)}
        onClose={() => setOfficeTarget(null)}
        onSaved={() => {
          message.success('已保存回文件服务器');
          void refreshAll();
        }}
      />
      <TextEditorModal
        open={Boolean(textEditTarget)}
        entry={textEditTarget}
        onClose={() => setTextEditTarget(null)}
        onSaved={() => {
          void refreshAll();
        }}
      />
      {renderNameDialog(ui)}
      {renderNewFileDialog(ui)}
      {renderShareModal(ui)}
      {renderManageModal(ui)}
      {renderTrashModal(ui)}
      {renderAuditModal(ui)}
    </PageShell>
  );
}
