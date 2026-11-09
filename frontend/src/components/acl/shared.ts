/** 共享文件源的界面名称与顺序，权限管理与文件管理共用同一套定义。 */
export const FILE_SOURCE_LABEL: Record<string, string> = {
  public: '公共资料',
  plasmids: '公共质粒',
  genomes: '公共基因组',
};

export const FILE_SOURCE_ORDER = ['public', 'plasmids', 'genomes'];