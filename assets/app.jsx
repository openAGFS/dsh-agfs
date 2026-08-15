/* ============================================================
 * 文件浏览器 - React 免构建版 (app.jsx)
 * ------------------------------------------------------------
 * 前端: React 18 UMD + ReactDOM + Babel Standalone(CDN 引入,免构建)
 * 后端: server.js (node:http 原生模块),API 前缀 /api/file_browser/
 * 样式: webbrowser.css 原样复用(不做任何改动)
 * 说明: 已移除全部智能体相关功能(AI解读/智能体面板/技能/模型),
 *       仅保留文件浏览、搜索、预览与文件操作能力。
 * ============================================================ */
const { useState, useEffect, useRef, useCallback } = React;

/* ============================ 全局与工具 ============================ */

// API 前缀由宿主插件在服务时通过 window.__DSH_AGFS__.apiPrefix 注入;未注入时回退到默认路径
const API_PREFIX = (typeof window !== 'undefined' && window.__DSH_AGFS__ && window.__DSH_AGFS__.apiPrefix) || '/api/file_browser/';

// 浏览根目录(与 URL ?path= 同步,附于所有 file_browser 请求,行为与 Flask 版一致)
let filepath = '';
// 当前目录(相对参数形式)
let currentPath = '';

/** 路径归一:Windows 路径转反斜杠,Unix 路径转正斜杠(与 Flask normalize_path 一致) */
function normalizePath(p) {
  if (!p) return p;
  if (p.includes('\\') || (p.length >= 2 && p[1] === ':')) {
    return p.replace(/\//g, '\\');
  }
  return p.replace(/\\/g, '/');
}

/** 相对路径 + 当前目录拼接为完整路径;绝对路径(盘符或 / 开头)原样返回 */
function getFullPath(relativePath) {
  if (!relativePath) return '';
  const isAbsolute = (relativePath.length >= 2 && relativePath[1] === ':') || relativePath.startsWith('/');
  if (isAbsolute) return normalizePath(relativePath);
  if (!currentPath) return normalizePath(relativePath);
  const sep = currentPath.includes('\\') ? '\\' : '/';
  const combined = currentPath.endsWith(sep) ? currentPath + relativePath : currentPath + sep + relativePath;
  return normalizePath(combined);
}

/** 构造 API URL(自动附带 filepath 根目录参数) */
function buildApiUrl(endpoint, params = {}) {
  let url = `${API_PREFIX}${endpoint}?`;
  if (filepath) url += `filepath=${encodeURIComponent(filepath)}&`;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url += `${key}=${encodeURIComponent(value)}&`;
  }
  return url.replace(/&$/, '');
}

/** GET 请求,成功返回 data */
async function apiGet(endpoint, params = {}) {
  const res = await fetch(buildApiUrl(endpoint, params));
  const json = await res.json().catch(() => ({ success: false, error: '响应解析失败' }));
  if (!json.success) throw new Error(json.error || '请求失败');
  return json.data;
}

/** POST 请求,成功返回完整响应对象 */
async function apiPost(endpoint, body = {}) {
  const res = await fetch(buildApiUrl(endpoint, {}), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ success: false, error: '响应解析失败' }));
  if (!json.success) throw new Error(json.error || '请求失败');
  return json;
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
function isImage(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return IMAGE_EXTS.indexOf(ext) !== -1;
}

/** 类型列文案(与 Flask 版 webbrowser.js getFileType 一致) */
const TYPE_MAP = {
  pdf: 'PDF', doc: 'Word', docx: 'Word',
  jpg: '图片', jpeg: '图片', png: '图片', gif: '图片', webp: '图片', bmp: '图片',
  mp3: '音频', wav: '音频',
  mp4: '视频', mkv: '视频',
  zip: '压缩包', rar: '压缩包', '7z': '压缩包',
  txt: '文本', md: 'Markdown',
  py: 'Python', js: 'JavaScript', html: 'HTML', css: 'CSS',
  json: 'JSON', xml: 'XML',
};
function getFileType(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return TYPE_MAP[ext] || '文件';
}

/** 文件图标(id + 颜色类,均为内联 SVG,颜色由 webbrowser.css 的 fill 规则控制) */
const ICON_MAP = {
  pdf: { id: 'icon-file', class: 'pdf-icon' },
  doc: { id: 'icon-file', class: 'word-icon' },
  docx: { id: 'icon-file', class: 'word-icon' },
  jpg: { id: 'icon-file', class: 'image-icon' },
  jpeg: { id: 'icon-file', class: 'image-icon' },
  png: { id: 'icon-file', class: 'image-icon' },
  gif: { id: 'icon-file', class: 'image-icon' },
  mp3: { id: 'icon-file', class: 'audio-icon' },
  wav: { id: 'icon-file', class: 'audio-icon' },
  mp4: { id: 'icon-file', class: 'video-icon' },
  mkv: { id: 'icon-file', class: 'video-icon' },
  zip: { id: 'icon-file', class: 'archive-icon' },
  rar: { id: 'icon-file', class: 'archive-icon' },
  '7z': { id: 'icon-file', class: 'archive-icon' },
};
function getFileIcon(type, name) {
  if (type === 'folder') return { id: 'icon-folder', class: 'folder-icon' };
  const ext = String(name).split('.').pop().toLowerCase();
  return ICON_MAP[ext] || { id: 'icon-file', class: 'file-icon' };
}

/** 排序(文件夹始终在前,与 Flask 版 sortItems 一致) */
function sortItems(items, field, direction) {
  const sorted = [...items];
  const mul = direction === 'asc' ? 1 : -1;
  sorted.sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    if (field === 'name') return mul * a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' });
    if (field === 'size') return mul * ((a.size_bytes || 0) - (b.size_bytes || 0));
    if (field === 'type') return mul * getFileType(a.name).localeCompare(getFileType(b.name), 'zh-CN', { sensitivity: 'base' });
    if (field === 'date') return mul * ((a.modified || '').localeCompare(b.modified || ''));
    return 0;
  });
  return sorted;
}

/** 底部 Toast(ai-toast,与 Flask 版 showToast 一致) */
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  let iconClass = 'check-circle';
  let toastClass = '';
  if (type === 'delete') { iconClass = 'trash-alt'; toastClass = 'delete'; }
  else if (type === 'error') { iconClass = 'exclamation-circle'; toastClass = 'error'; }
  else if (type === 'warning') { iconClass = 'exclamation-triangle'; toastClass = 'warning'; }
  else { toastClass = 'success'; }
  toast.className = 'ai-toast' + (toastClass ? ' ' + toastClass : '');
  toast.innerHTML = `<i class="fas fa-${iconClass}"></i> ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/** 远程模式提示(toast,顶部) */
function showRemoteModeTip() {
  const tip = document.createElement('div');
  tip.className = 'toast';
  tip.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
  tip.style.boxShadow = '0 8px 25px rgba(245, 158, 11, 0.3)';
  tip.innerHTML = '<i class="fas fa-info-circle"></i> 远程模式下暂不支持打开文件，请下载后查看';
  document.body.appendChild(tip);
  setTimeout(() => {
    tip.style.animation = 'toastOut 0.3s ease-in forwards';
    setTimeout(() => tip.remove(), 300);
  }, 2500);
}

/** 判断当前路径是否位于目标路径下(用于侧边栏高亮当前所在位置) */
function pathIsInside(current, target) {
  const cur = normalizePath(current || '');
  const tgt = normalizePath(target || '');
  if (!tgt) return cur === '';
  if (cur === tgt) return true;
  const sep = cur.includes('\\') ? '\\' : '/';
  return cur.startsWith(tgt.replace(/[\\/]+$/, '') + sep);
}

/* ============================ 侧边栏 ============================ */

function iconForQuick(name) {
  if (name === '下载') return 'icon-download';
  if (name === '桌面') return 'icon-desktop';
  return 'icon-folder';
}

function Sidebar({ remoteMode, curPath, project, quick, drives, roots, onHome, onNavigate }) {
  const isActive = (target) => pathIsInside(curPath, target);
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="logo-icon">
          <svg><use href="#icon-folder-open" /></svg>
        </div>
        <span className="logo-text">文件浏览器</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div className="nav-section">
          <div className="nav-label">快速访问</div>
          {project && (
            <button className={`nav-item${isActive(project) ? ' active' : ''}`} title={project} onClick={() => onNavigate(project)}>
              <svg><use href="#icon-project" /></svg> 项目目录
            </button>
          )}
          {quick.map((q) => (
            <button key={q.path} className={`nav-item${isActive(q.path) ? ' active' : ''}`} title={q.path} onClick={() => onNavigate(q.path)}>
              <svg><use href={'#' + iconForQuick(q.name)} /></svg>
              {q.name}
            </button>
          ))}
        </div>
        {roots && roots.length > 0 && (
          <React.Fragment>
            <div className="ai-divider" style={{ margin: '6px 8px' }} />
            <div className="nav-section">
              <div className="nav-label">自定义根</div>
              {roots.map((r) => (
                <button key={r.path} className={`nav-item${isActive(r.path) ? ' active' : ''}`} title={r.path} onClick={() => onNavigate(r.path)}>
                  <svg><use href="#icon-folder" /></svg>
                  <span>{r.name}</span>
                </button>
              ))}
            </div>
          </React.Fragment>
        )}
        <div className="ai-divider" style={{ margin: '6px 8px' }} />
        <div className="nav-section">
          <div className="nav-label">磁盘驱动器</div>
          <button className={`nav-item${isActive('') ? ' active' : ''}`} onClick={onHome}>
            <svg><use href="#icon-home" /></svg> 此电脑
          </button>
          {drives.map((d) => (
            <button key={d.path} className={`nav-item${isActive(d.path) ? ' active' : ''}`} title={d.path} onClick={() => onNavigate(d.path)}>
              <svg><use href="#icon-drive" /></svg>
              <span>{d.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={`mode-indicator${remoteMode ? ' remote' : ''}`}>
        <div className="mode-dot" />
        <span className="mode-text">{remoteMode ? '远程模式' : '本机模式'}</span>
        <span className="mode-badge">{remoteMode ? '远程' : '本地'}</span>
      </div>
    </div>
  );
}

/* ============================ 工具栏 ============================ */

function Toolbar({ crumbs, onNavigate, searchText, onSearch, viewMode, onViewMode, onNewFolder, onToggleSidebar, isFullscreen, onToggleFullscreen }) {
  const curStyle = { background: 'white', color: '#0b1e33', fontWeight: 600 };
  const separator = (crumbs || '').includes('\\') ? '\\' : '/';

  let breadcrumbNodes;
  if (!crumbs) {
    breadcrumbNodes = (
      <span className="breadcrumb-item" style={curStyle} onClick={() => onNavigate('')}>
        <svg><use href="#icon-home" /></svg> 此电脑
      </span>
    );
  } else {
    const parts = String(crumbs).split(separator).filter(Boolean);
    const nodes = [
      <span key="root" className="breadcrumb-item" onClick={() => onNavigate('')}>此电脑</span>,
      <span key="sep0" className="breadcrumb-separator"><svg><use href="#icon-chevron-right" /></svg></span>,
    ];
    let fullPath = '';
    parts.forEach((part, idx) => {
      fullPath += (fullPath ? separator : '') + part;
      const crumbPath = fullPath; // 捕获本次迭代值,避免闭包捕获循环最终值导致所有 crumb 跳同一路径
      const isLast = idx === parts.length - 1;
      nodes.push(
        <span key={'c' + idx} className="breadcrumb-item" style={isLast ? curStyle : undefined} onClick={() => onNavigate(crumbPath)}>{part}</span>
      );
      if (!isLast) {
        nodes.push(<span key={'s' + idx} className="breadcrumb-separator"><svg><use href="#icon-chevron-right" /></svg></span>);
      }
    });
    breadcrumbNodes = nodes;
  }

  return (
    <div className="toolbar">
      <div className="breadcrumb">{breadcrumbNodes}</div>
      <div className="toolbar-right">
        <button className="view-btn sidebar-toggle-btn" title="菜单" onClick={onToggleSidebar}>
          <i className="fa-solid fa-bars" />
        </button>
        <div className="search-box">
          <i className="fa-solid fa-magnifying-glass" />
          <input
            type="text"
            placeholder="搜索文件..."
            value={searchText}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <div className="view-toggle">
          <button className={`view-btn${viewMode === 'list' ? ' active' : ''}`} title="列表视图" onClick={() => onViewMode('list')}>
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M0 2h16v2H0V2zm0 4h16v2H0V6zm0 4h16v2H0v-2zm0 4h16v2H0v-2z" /></svg>
          </button>
          <button className={`view-btn${viewMode === 'grid' ? ' active' : ''}`} title="卡片视图" onClick={() => onViewMode('grid')}>
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M1 1h6v6H1V1zm8 0h6v6H9V1zM1 9h6v6H1V9zm8 0h6v6H9V9z" /></svg>
          </button>
        </div>
        <button className="view-btn" title="新建文件夹" onClick={onNewFolder}>
          <i className="fa-solid fa-folder-plus" />
        </button>
        <button className="view-btn" title={isFullscreen ? '退出全屏' : '全屏'} onClick={onToggleFullscreen}>
          <i className={`fa-solid ${isFullscreen ? 'fa-compress' : 'fa-expand'}`} />
        </button>
      </div>
    </div>
  );
}

/* ============================ 列表头(排序) ============================ */

const SORT_DEFS = [
  { field: 'name', label: '名称', col: 'col-name' },
  { field: 'date', label: '修改日期', col: 'col-date' },
  { field: 'type', label: '类型', col: 'col-type' },
  { field: 'size', label: '大小', col: 'col-size' },
];

function ListHeader({ sort, onSort }) {
  return (
    <div className="list-header">
      {SORT_DEFS.map((s) => (
        <span key={s.field} className={`sortable ${s.col}`} onClick={() => onSort(s.field)}>
          {s.label}
          <span className={`sort-icon${sort.field === s.field ? ' active' : ''}`}>
            {sort.field === s.field ? (sort.direction === 'asc' ? '↑' : '↓') : ''}
          </span>
        </span>
      ))}
    </div>
  );
}

/* ============================ 图标 / 缩略图 ============================ */

function ItemIcon({ item, thumbSize, thumbClass, onPreview }) {
  const [failed, setFailed] = useState(false);
  if (item.type === 'folder' || item.type === 'parent') {
    return <svg className="folder-icon"><use href="#icon-folder" /></svg>;
  }
  if (isImage(item.name) && !failed) {
    return (
      <img
        className={thumbClass}
        src={buildApiUrl('thumbnail', { path: getFullPath(item.path || item.name), size: thumbSize })}
        alt={item.name}
        loading="lazy"
        style={{ cursor: 'zoom-in' }}
        onClick={(e) => onPreview(item, e)}
        onError={() => setFailed(true)}
      />
    );
  }
  const icon = getFileIcon(item.type, item.name);
  return <svg className={icon.class}><use href={'#' + icon.id} /></svg>;
}

/* ============================ 列表行 ============================ */

function FileRow({ item, rename, highlightPath, onRenameChange, onRenameCommit, onRenameCancel, onOpen, onContext, onPreview, onDownload }) {
  const isRenaming = !!(rename && rename.item === item);
  const isParent = item.type === 'parent';
  const highlighted = !!highlightPath && getFullPath(item.path || item.name) === highlightPath;
  const hlStyle = { background: 'rgba(16, 185, 129, 0.2)', padding: '2px 8px', borderRadius: '4px' };
  const size = isParent ? '—' : (item.type === 'folder' ? '—' : (item.size || '—'));
  const fileType = isParent ? '—' : (item.type === 'folder' ? '文件夹' : getFileType(item.name));

  return (
    <div className="file-row" data-type={item.type} data-path={item.path || item.name}
      onClick={isParent ? () => onOpen(item) : undefined}
      onDoubleClick={() => onOpen(item)} onContextMenu={(e) => onContext(e, item)}>
      <div className="name-cell">
        <ItemIcon item={item} thumbSize={64} thumbClass="file-thumb" onPreview={onPreview} />
        <span style={highlighted ? hlStyle : undefined}>
          {isRenaming ? (
            <input
              className="rename-input"
              value={rename.value}
              autoFocus
              ref={(el) => el && el.select()}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRenameCommit(rename);
                if (e.key === 'Escape') onRenameCancel();
              }}
              onBlur={() => onRenameCommit(rename)}
            />
          ) : item.name}
          {isRenaming && rename.error && <div className="rename-error">{rename.error}</div>}
        </span>
        {item.type === 'file' && !isRenaming && (
          <div className="file-actions">
            <button className="btn-action" onClick={(e) => onDownload(item, e)}>下载</button>
          </div>
        )}
      </div>
      <div className="date-cell">{isParent ? '—' : (item.modified || '—')}</div>
      <div className="type-cell">{fileType}</div>
      <div className="size-cell">{size}</div>
    </div>
  );
}

/* ============================ 网格卡片 ============================ */

function FileCard({ item, rename, highlightPath, onRenameChange, onRenameCommit, onRenameCancel, onOpen, onContext, onPreview, onDownload }) {
  const isRenaming = !!(rename && rename.item === item);
  const highlighted = !!highlightPath && getFullPath(item.path || item.name) === highlightPath;
  const hlStyle = { background: 'rgba(16, 185, 129, 0.2)', padding: '2px 8px', borderRadius: '4px' };
  const info = item.type === 'folder' ? '文件夹' : (item.type === 'parent' ? '—' : (item.size || '—'));

  return (
    <div className="file-card" data-type={item.type} data-path={item.path || item.name}
      onClick={item.type === 'parent' ? () => onOpen(item) : undefined}
      onDoubleClick={() => onOpen(item)} onContextMenu={(e) => onContext(e, item)}>
      <div className="card-icon">
        <ItemIcon item={item} thumbSize={96} thumbClass="card-thumb" onPreview={onPreview} />
      </div>
      <div className="card-name" style={highlighted ? hlStyle : undefined}>
        {isRenaming ? (
          <input
            className="rename-input"
            value={rename.value}
            autoFocus
            ref={(el) => el && el.select()}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit(rename);
              if (e.key === 'Escape') onRenameCancel();
            }}
            onBlur={() => onRenameCommit(rename)}
          />
        ) : item.name}
        {isRenaming && rename.error && <div className="rename-error">{rename.error}</div>}
      </div>
      <div className="card-info">{info}</div>
      {item.type === 'file' && !isRenaming && (
        <div className="card-actions">
          <button className="btn-action" onClick={(e) => onDownload(item, e)}>下载</button>
        </div>
      )}
    </div>
  );
}

/* ============================ 文件列表区 ============================ */

/** 计算 current_path 的真实父目录(供".. (返回上级)"行导航;服务端 parent_path 对盘符路径为 "",无法直接使用) */
function parentOf(cur) {
  if (!cur) return '';
  const sep = cur.includes('\\') ? '\\' : '/';
  const t = String(cur).replace(/[\\/]+$/, '');
  const idx = t.lastIndexOf(sep);
  if (idx < 0) return '';
  if (idx === 0) return sep; // Unix 根目录
  return t.slice(0, idx);
}

function FileList({ data, items, viewMode, searching, searchLoading, searchResults, loading, loadError,
  rename, highlightPath, onRenameChange, onRenameCommit, onRenameCancel, onOpen, onContext, onPreview, onDownload }) {
  if (searchLoading) return <div className="file-list"><div className="loading">搜索中...</div></div>;
  if (loading) return <div className="file-list"><div className="loading">加载中...</div></div>;
  if (loadError) return <div className="file-list"><div className="empty-folder">{loadError}</div></div>;

  if (searching) {
    if (!searchResults.length) return <div className="file-list"><div className="empty-folder">未找到匹配的文件</div></div>;
    return (
      <div className="file-list">
        <div style={{ padding: '10px', color: '#64748b', fontSize: '14px' }}>找到 {searchResults.length} 个结果</div>
        {searchResults.map((item) => (
          <FileRow key={item.path} item={item} rename={rename} highlightPath={highlightPath}
            onRenameChange={onRenameChange} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel}
            onOpen={onOpen} onContext={onContext} onPreview={onPreview} onDownload={onDownload} />
        ))}
      </div>
    );
  }

  // 父目录行始终渲染(空目录也要能返回上级),空提示显示在其下方
  const showParent = data && data.parent_path !== undefined && data.parent_path !== data.current_path;
  const parentItem = showParent ? { name: '.. (返回上级)', path: parentOf(data.current_path), type: 'parent' } : null;

  if (viewMode === 'grid') {
    return (
      <div className="file-list">
        <div className="file-grid">
          {parentItem && <FileCard key="parent" item={parentItem} rename={null} highlightPath="" onOpen={onOpen} onContext={onContext} onPreview={onPreview} onDownload={onDownload} />}
          {items.map((item) => (
            <FileCard key={item.path} item={item} rename={rename} highlightPath={highlightPath}
              onRenameChange={onRenameChange} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel}
              onOpen={onOpen} onContext={onContext} onPreview={onPreview} onDownload={onDownload} />
          ))}
        </div>
        {!items.length && <div className="empty-folder">此文件夹为空</div>}
      </div>
    );
  }

  return (
    <div className="file-list">
      {parentItem && <FileRow key="parent" item={parentItem} rename={null} highlightPath="" onOpen={onOpen} onContext={onContext} onPreview={onPreview} onDownload={onDownload} />}
      {items.map((item) => (
        <FileRow key={item.path} item={item} rename={rename} highlightPath={highlightPath}
          onRenameChange={onRenameChange} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel}
          onOpen={onOpen} onContext={onContext} onPreview={onPreview} onDownload={onDownload} />
      ))}
      {!items.length && <div className="empty-folder">此文件夹为空</div>}
    </div>
  );
}

/* ============================ 右键菜单 ============================ */

function ContextMenu({ menu, remoteMode, menuRef, onOpen, onOpenLocation, onCopy, onRename, onDelete, onProperty }) {
  const item = menu ? menu.item : null;
  const isParent = !!(item && item.type === 'parent');
  return (
    <div className={`context-menu${menu ? ' active' : ''}`} ref={menuRef} style={menu ? { left: menu.x, top: menu.y } : undefined}>
      <div className="context-menu-item" onClick={onOpen}>
        <i className="fas fa-folder-open" /><span>打开</span>
      </div>
      <div className={`context-menu-item${remoteMode ? ' disabled' : ''}`} onClick={onOpenLocation}>
        <i className="fas fa-external-link-alt" /><span>打开所在目录</span>
      </div>
      <div className={`context-menu-item${(remoteMode || isParent) ? ' disabled' : ''}`} onClick={onCopy}>
        <i className="fas fa-copy" /><span>复制</span>
      </div>
      <div className="context-menu-divider" />
      <div className={`context-menu-item${isParent ? ' disabled' : ''}`} onClick={onRename}>
        <i className="fas fa-edit" /><span>重命名</span>
      </div>
      <div className={`context-menu-item${isParent ? ' disabled' : ''}`} onClick={onDelete}>
        <i className="fas fa-trash-alt" /><span>删除</span>
      </div>
      <div className="context-menu-divider" />
      <div className="context-menu-item" onClick={onProperty}>
        <i className="fas fa-info-circle" /><span>属性</span>
      </div>
    </div>
  );
}

/* ============================ 预览(图片 + 文本) ============================ */

const TEXT_PREVIEW_EXTS = ['txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'html', 'htm', 'css', 'xml', 'yml', 'yaml', 'log', 'csv', 'ini', 'conf', 'sh', 'bat', 'ps1', 'env', 'gitignore'];
function isTextPreview(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return TEXT_PREVIEW_EXTS.indexOf(ext) !== -1;
}

function PreviewOverlay({ preview, onClose }) {
  const [text, setText] = useState(null);
  const [textError, setTextError] = useState(null);
  const isText = !!(preview && isTextPreview(preview.name));
  useEffect(() => {
    if (!isText) { setText(null); setTextError(null); return; }
    let cancelled = false;
    apiGet('read', { path: preview.path })
      .then((data) => {
        if (cancelled) return;
        setText(data.content);
        setTextError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setText(null);
        setTextError((err && err.message) || String(err));
      });
    return () => { cancelled = true; };
  }, [preview, isText]);
  if (!preview) return null;
  return (
    <div className="preview-overlay active" onClick={onClose}>
      <button className="preview-close" onClick={onClose}>&times;</button>
      {isText
        ? (textError
          ? <div className="preview-text preview-error" onClick={(e) => e.stopPropagation()}>{textError}</div>
          : text === null
            ? <div className="preview-text preview-loading">加载中…</div>
            : <pre className="preview-text" onClick={(e) => e.stopPropagation()}>{text}</pre>)
        : <img src={buildApiUrl('download', { path: preview.path })} alt={preview.name} />}
      <div className="preview-info">{preview.name}</div>
    </div>
  );
}

/* ============================ 删除确认对话框 ============================ */

function ConfirmDialog({ item, onCancel, onConfirm }) {
  if (!item) return null;
  return (
    <div className="confirm-dialog active" onClick={onCancel}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-icon">
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>
        </div>
        <div className="dialog-title">确认删除</div>
        <div className="dialog-message">确定要删除 "{item.name}" 吗？此操作无法撤销。</div>
        <div className="dialog-actions">
          <button className="dialog-btn dialog-btn-cancel" onClick={onCancel}>取消</button>
          <button className="dialog-btn dialog-btn-danger" onClick={onConfirm}>删除</button>
        </div>
      </div>
    </div>
  );
}

/* ============================ 属性对话框 ============================ */

function PropertyDialog({ item, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!item) return null;
  const isFolder = item.type === 'folder';
  const isImg = !isFolder && isImage(item.name);
  const iconClass = isFolder ? 'folder' : (isImg ? 'image' : 'file');
  const iconPath = isFolder
    ? 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z'
    : (isImg
      ? 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'
      : 'M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm0 2h7v5h5v11H6V4z');
  const fullPath = getFullPath(item.path || item.name);

  const copyPath = () => {
    navigator.clipboard.writeText(fullPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => showToast('复制失败', 'error'));
  };

  return (
    <div className="property-dialog active" onClick={onClose}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div className={`dialog-icon ${iconClass}`}>
            <svg viewBox="0 0 24 24"><path d={iconPath} /></svg>
          </div>
          <div className="file-name">{item.name}</div>
        </div>
        <div className="property-grid">
          <div className="property-label">类型</div>
          <div className="property-value">{isFolder ? '文件夹' : getFileType(item.name)}</div>
          <div className="property-label">大小</div>
          <div className="property-value">{isFolder ? '—' : (item.size || '—')}</div>
          <div className="property-label">修改日期</div>
          <div className="property-value">{item.modified || '—'}</div>
          <div className="property-label">路径</div>
          <div className="property-value path-value">
            <span className="path-text">{fullPath}</span>
            <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copyPath}>{copied ? '已复制' : '复制'}</button>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/* ============================ 新建文件夹对话框 ============================ */

function NewFolderDialog({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  if (!open) return null;
  const submit = () => onCreate(name.trim());
  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">新建文件夹</div>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <input
            className="ai-form-input"
            placeholder="输入文件夹名称"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>取消</button>
          <button className="modal-btn modal-btn-download" onClick={submit}>创建</button>
        </div>
      </div>
    </div>
  );
}

/** 安全读取视图模式(Edge 跟踪防护等场景可能禁止 localStorage 访问) */
function loadViewMode() {
  try { return localStorage.getItem('fileBrowserViewMode') || 'list'; } catch (e) { return 'list'; }
}

/** 安全保存视图模式 */
function saveViewMode(mode) {
  try { localStorage.setItem('fileBrowserViewMode', mode); } catch (e) { /* 忽略存储受限 */ }
}

/* ============================ 主应用 ============================ */

function App() {
  const [remoteMode, setRemoteMode] = useState(false);
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [curPath, setCurPath] = useState(''); // 当前目录(用于侧边栏高亮)
  const [sidebarData, setSidebarData] = useState({ project: null, quick: [], drives: [] });
  const [viewMode, setViewMode] = useState(loadViewMode);
  const [sort, setSort] = useState({ field: 'name', direction: 'asc' });
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [ctxMenu, setCtxMenu] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [propertyItem, setPropertyItem] = useState(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [rename, setRename] = useState(null);
  const [highlightPath, setHighlightPath] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false); // 窄屏侧边栏抽屉
  const [isFullscreen, setIsFullscreen] = useState(false);

  const searchTimer = useRef(null);
  const menuRef = useRef(null);
  const renameRef = useRef(null);         // 当前重命名对象(渲染体内同步,供 blur 判断是否过期)
  const renamingBusyRef = useRef(false);  // 重命名请求进行中标记
  const loadDirRef = useRef(null);

  /* ---- 加载目录(更新 URL + 全局 filepath + 拉取列表) ---- */
  const loadDirectory = useCallback(async (path) => {
    setLoading(true);
    setLoadError('');
    setSearchLoading(false);
    setSearching(false);
    setSearchResults([]);
    // 更新 URL(不刷新页面)
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('path', path);
    history.pushState({ path }, '', newUrl);
    // 同步更新全局 filepath,使其与 URL 保持一致
    filepath = new URLSearchParams(window.location.search).get('path') || '';
    currentPath = path;
    setCurPath(path);
    setSidebarOpen(false); // 窄屏下选择目标后收起抽屉
    try {
      const result = await apiGet('list', { path });
      setData(result);
      setItems(sortItems(result.items, sort.field, sort.direction));
    } catch (e) {
      console.error('加载目录失败:', e);
      setData(null);
      setItems([]);
      setLoadError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [sort.field, sort.direction]);

  loadDirRef.current = loadDirectory;
  renameRef.current = rename; // 渲染体内同步,确保 blur 时能判断"当前是否仍在编辑该项"

  /* ---- 搜索(500ms 节流,与 Flask 版一致) ---- */
  const handleSearch = (text) => {
    setSearchText(text);
    clearTimeout(searchTimer.current);
    const keyword = text.trim();
    if (!keyword) {
      loadDirectory(currentPath);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearchLoading(true);
      setLoadError('');
      try {
        const result = await apiGet('search', { path: currentPath, keyword });
        setSearching(true);
        setSearchResults(result.results || []);
      } catch (e) {
        console.error('搜索失败:', e);
        setLoadError(e.message || '搜索失败');
      } finally {
        setSearchLoading(false);
      }
    }, 500);
  };

  /* ---- 排序 ---- */
  const handleSort = (field) => {
    const next = sort.field === field
      ? { field, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
      : { field, direction: 'asc' };
    setSort(next);
    setItems(sortItems(items, next.field, next.direction));
  };

  /* ---- 视图切换 ---- */
  const handleViewMode = (mode) => {
    setViewMode(mode);
    saveViewMode(mode);
  };

  /* ---- 系统程序打开文件 ---- */
  const openFileInSystem = async (path) => {
    try {
      const res = await fetch(buildApiUrl('open', { path }));
      const result = await res.json();
      if (!result.success) showToast('打开失败: ' + result.error, 'error');
    } catch (e) {
      showToast('打开失败: ' + e.message, 'error');
    }
  };

  /* ---- 打开/预览(双击与右键"打开"共用) ---- */
  const openItem = (item) => {
    if (!item) return;
    if (item.type === 'folder' || item.type === 'parent') {
      loadDirectory(getFullPath(item.path || item.name));
      return;
    }
    if (remoteMode && !isImage(item.name)) {
      showRemoteModeTip();
      return;
    }
    if (isImage(item.name)) {
      setPreview({ path: getFullPath(item.path || item.name), name: item.name });
      return;
    }
    openFileInSystem(getFullPath(item.path || item.name));
  };

  /* ---- 缩略图点击预览 ---- */
  const previewOpen = (item, e) => {
    if (e) e.stopPropagation();
    setPreview({ path: getFullPath(item.path || item.name), name: item.name });
  };

  /* ---- 下载 ---- */
  const doDownload = (item, e) => {
    if (e) e.stopPropagation();
    window.open(buildApiUrl('download', { path: getFullPath(item.path || item.name) }), '_blank');
  };

  /* ---- 右键菜单 ---- */
  const handleContext = (e, item) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, item });
  };

  const ctxOpen = () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    openItem(item);
  };

  const ctxOpenLocation = async () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    if (!item || remoteMode) return;
    const path = getFullPath(item.path || item.name);
    try {
      const res = await fetch(buildApiUrl('open_location', { path }));
      const result = await res.json();
      if (!result.success) showToast('打开失败: ' + result.error, 'error');
    } catch (e) {
      showToast('打开失败: ' + e.message, 'error');
    }
  };

  const ctxCopy = async () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    if (!item || remoteMode || item.type === 'parent') return;
    const srcPath = getFullPath(item.path || item.name);
    const newName = `复件_${item.name}`;
    const destPath = getFullPath(newName);
    try {
      const result = await apiPost('copy', { path: srcPath, dest_path: destPath });
      const newItem = {
        ...item,
        name: newName,
        path: result.dest_path || destPath,
        modified: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
      setItems((prev) => [newItem, ...prev]);
      setHighlightPath(newItem.path);
      setTimeout(() => setHighlightPath(''), 1500);
      showToast('复制成功');
    } catch (e) {
      alert('复制失败: ' + e.message);
    }
  };

  const ctxDelete = () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    if (item && item.type !== 'parent') setConfirmTarget(item);
  };

  const ctxProperty = () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    if (item) setPropertyItem(item);
  };

  /* ---- 重命名(行内编辑) ---- */
  const startRename = (item) => setRename({ item, value: item.name, error: '' });

  const commitRename = async (r) => {
    if (renamingBusyRef.current) return;
    if (!r || renameRef.current !== r) return; // 已切换/取消/完成,忽略过期 blur
    const oldName = r.item.name;
    const ext = oldName.includes('.') ? '.' + oldName.split('.').pop() : '';
    const newBaseName = r.value.trim();
    const newName = newBaseName.includes('.') ? newBaseName : newBaseName + ext;

    if (!newBaseName) { setRename({ ...r, error: '文件名不能为空' }); return; }
    const illegal = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    for (const ch of illegal) {
      if (newName.includes(ch)) { setRename({ ...r, error: `文件名不能包含: ${ch}` }); return; }
    }

    renamingBusyRef.current = true;
    try {
      const result = await apiPost('rename', { path: getFullPath(r.item.path || r.item.name), new_name: newName });
      if (renameRef.current !== r) return; // 提交期间被新流程取代
      const newPath = result.new_path || getFullPath(r.item.path || r.item.name);
      setItems((prev) => prev.map((it) => (it === r.item ? { ...it, name: newName, path: newPath } : it)));
      if (searching) setSearchResults((prev) => prev.map((it) => (it === r.item ? { ...it, name: newName, path: newPath } : it)));
      setRename(null);
      setHighlightPath(newPath);
      setTimeout(() => setHighlightPath(''), 1500);
      showToast('重命名成功');
    } catch (e) {
      if (renameRef.current !== r) return;
      setRename({ ...r, error: e.message || '重命名失败' });
    } finally {
      renamingBusyRef.current = false;
    }
  };

  const cancelRename = () => {
    setRename(null);
  };

  /* ---- 删除 ---- */
  const confirmDelete = async () => {
    const item = confirmTarget;
    if (!item) return;
    setConfirmTarget(null);
    try {
      await apiPost('delete', { path: getFullPath(item.path || item.name) });
      setItems((prev) => prev.filter((it) => it !== item));
      setSearchResults((prev) => prev.filter((it) => it !== item));
      showToast('删除成功');
    } catch (e) {
      alert('删除失败: ' + e.message);
    }
  };

  /* ---- 新建文件夹 ---- */
  const handleCreateFolder = async (name) => {
    if (!name) { showToast('请输入文件夹名称', 'warning'); return; }
    try {
      const result = await apiPost('create_folder', { path: getFullPath(name) });
      setNewFolderOpen(false);
      await loadDirectory(currentPath);
      setHighlightPath(result.path || getFullPath(name));
      setTimeout(() => setHighlightPath(''), 1500);
      showToast('创建成功');
    } catch (e) {
      showToast('创建失败: ' + e.message, 'error');
    }
  };

  /* ---- 全屏切换(浏览器 Fullscreen API) ---- */
  const toggleFullscreen = () => {
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    } catch (e) { /* 忽略不支持的环境 */ }
  };

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  /* ---- 效果:关闭右键菜单(点击空白/非文件区右键) ---- */
  useEffect(() => {
    const onDocClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setCtxMenu(null);
    };
    const onDocCtx = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target) &&
          !(e.target.closest && e.target.closest('.file-row, .file-card'))) setCtxMenu(null);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('contextmenu', onDocCtx);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('contextmenu', onDocCtx);
    };
  }, []);

  /* ---- 效果:右键菜单位置钳制(不超出视窗) ----
     注意用 offsetWidth/offsetHeight 而非 getBoundingClientRect:
     入口动画 scale(0.95) 会缩放 rect,导致钳制不足 */
  useEffect(() => {
    if (!ctxMenu || !menuRef.current) return;
    const w = menuRef.current.offsetWidth;
    const h = menuRef.current.offsetHeight;
    let { x, y } = ctxMenu;
    if (x + w > window.innerWidth) x = window.innerWidth - w - 10;
    if (y + h > window.innerHeight) y = window.innerHeight - h - 10;
    if (x !== ctxMenu.x || y !== ctxMenu.y) setCtxMenu({ ...ctxMenu, x, y });
  }, [ctxMenu]);

  /* ---- 效果:ESC 关闭预览 ---- */
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ---- 效果:浏览器前进/后退 ---- */
  useEffect(() => {
    const onPop = (e) => {
      loadDirRef.current((e.state && e.state.path) || '');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /* ---- 效果:初始加载(模式检测 + 侧边栏数据 + 首目录) ---- */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(API_PREFIX + 'mode');
        const json = await res.json();
        if (json.success) setRemoteMode(!!json.data.remote_mode);
      } catch (e) {
        console.error('获取模式失败:', e);
      }
      apiGet('sidebar').then((d) => {
        setSidebarData({ project: (d && d.project) || null, quick: (d && d.quick) || [], drives: (d && d.drives) || [] });
      }).catch(() => {});
      const initialPath = new URL(window.location.href).searchParams.get('path') || '';
      loadDirRef.current(initialPath);
    })();
    return () => clearTimeout(searchTimer.current);
  }, []);

  return (
    <React.Fragment>
      {/* 主界面(浮层必须在 .browser 之外:.browser 带 backdrop-filter + overflow:hidden,
          会让 position:fixed 后代相对其盒子定位并裁剪,导致右键菜单位置偏移/被裁剪) */}
      <div className={`browser${sidebarOpen ? ' sidebar-open' : ''}`}>
        <Sidebar remoteMode={remoteMode} curPath={curPath} project={sidebarData.project} quick={sidebarData.quick} drives={sidebarData.drives} roots={sidebarData.roots} onHome={() => loadDirectory('')} onNavigate={loadDirectory} />
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        <div className="main">
          <Toolbar
            crumbs={data ? data.current_path : ''}
            onNavigate={loadDirectory}
            searchText={searchText}
            onSearch={handleSearch}
            viewMode={viewMode}
            onViewMode={handleViewMode}
            onNewFolder={() => setNewFolderOpen(true)}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            isFullscreen={isFullscreen}
            onToggleFullscreen={toggleFullscreen}
          />
          <ListHeader sort={sort} onSort={handleSort} />
          <FileList
            data={data}
            items={items}
            viewMode={viewMode}
            searching={searching}
            searchLoading={searchLoading}
            searchResults={searchResults}
            loading={loading}
            loadError={loadError}
            rename={rename}
            highlightPath={highlightPath}
            onRenameChange={(v) => setRename((prev) => (prev ? { ...prev, value: v } : prev))}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            onOpen={openItem}
            onContext={handleContext}
            onPreview={previewOpen}
            onDownload={doDownload}
          />
        </div>
      </div>
      <ContextMenu
        menu={ctxMenu}
        remoteMode={remoteMode}
        menuRef={menuRef}
        onOpen={ctxOpen}
        onOpenLocation={ctxOpenLocation}
        onCopy={ctxCopy}
        onRename={() => { const it = ctxMenu && ctxMenu.item; setCtxMenu(null); if (it && it.type !== 'parent') startRename(it); }}
        onDelete={ctxDelete}
        onProperty={ctxProperty}
      />
      <PreviewOverlay preview={preview} onClose={() => setPreview(null)} />
      <ConfirmDialog item={confirmTarget} onCancel={() => setConfirmTarget(null)} onConfirm={confirmDelete} />
      <PropertyDialog item={propertyItem} onClose={() => setPropertyItem(null)} />
      <NewFolderDialog open={newFolderOpen} onClose={() => setNewFolderOpen(false)} onCreate={handleCreateFolder} />
    </React.Fragment>
  );
}

/* ============================ 挂载 ============================ */
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
