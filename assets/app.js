"use strict";
const { useState, useEffect, useRef, useCallback } = React;
const API_PREFIX = typeof window !== "undefined" && window.__DSH_AGFS__ && window.__DSH_AGFS__.apiPrefix || "/api/file_browser/";
let filepath = "";
let currentPath = "";
function normalizePath(p) {
  if (!p) return p;
  if (p.includes("\\") || p.length >= 2 && p[1] === ":") {
    return p.replace(/\//g, "\\");
  }
  return p.replace(/\\/g, "/");
}
function getFullPath(relativePath) {
  if (!relativePath) return "";
  const isAbsolute = relativePath.length >= 2 && relativePath[1] === ":" || relativePath.startsWith("/");
  if (isAbsolute) return normalizePath(relativePath);
  if (!currentPath) return normalizePath(relativePath);
  const sep = currentPath.includes("\\") ? "\\" : "/";
  const combined = currentPath.endsWith(sep) ? currentPath + relativePath : currentPath + sep + relativePath;
  return normalizePath(combined);
}
function buildApiUrl(endpoint, params = {}) {
  let url = `${API_PREFIX}${endpoint}?`;
  if (filepath) url += `filepath=${encodeURIComponent(filepath)}&`;
  for (const [key, value] of Object.entries(params)) {
    if (value === void 0 || value === null || value === "") continue;
    url += `${key}=${encodeURIComponent(value)}&`;
  }
  return url.replace(/&$/, "");
}
async function apiGet(endpoint, params = {}) {
  const res = await fetch(buildApiUrl(endpoint, params));
  const json = await res.json().catch(() => ({ success: false, error: "响应解析失败" }));
  if (!json.success) throw new Error(json.error || "请求失败");
  return json.data;
}
async function apiPost(endpoint, body = {}) {
  const res = await fetch(buildApiUrl(endpoint, {}), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({ success: false, error: "响应解析失败" }));
  if (!json.success) throw new Error(json.error || "请求失败");
  return json;
}
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];
function isImage(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return IMAGE_EXTS.indexOf(ext) !== -1;
}
const TYPE_MAP = {
  pdf: "PDF",
  doc: "Word",
  docx: "Word",
  jpg: "图片",
  jpeg: "图片",
  png: "图片",
  gif: "图片",
  webp: "图片",
  bmp: "图片",
  mp3: "音频",
  wav: "音频",
  mp4: "视频",
  mkv: "视频",
  zip: "压缩包",
  rar: "压缩包",
  "7z": "压缩包",
  txt: "文本",
  md: "Markdown",
  py: "Python",
  js: "JavaScript",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  xml: "XML"
};
function getFileType(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return TYPE_MAP[ext] || "文件";
}
const ICON_MAP = {
  pdf: { id: "icon-file", class: "pdf-icon" },
  doc: { id: "icon-file", class: "word-icon" },
  docx: { id: "icon-file", class: "word-icon" },
  jpg: { id: "icon-file", class: "image-icon" },
  jpeg: { id: "icon-file", class: "image-icon" },
  png: { id: "icon-file", class: "image-icon" },
  gif: { id: "icon-file", class: "image-icon" },
  mp3: { id: "icon-file", class: "audio-icon" },
  wav: { id: "icon-file", class: "audio-icon" },
  mp4: { id: "icon-file", class: "video-icon" },
  mkv: { id: "icon-file", class: "video-icon" },
  zip: { id: "icon-file", class: "archive-icon" },
  rar: { id: "icon-file", class: "archive-icon" },
  "7z": { id: "icon-file", class: "archive-icon" }
};
function getFileIcon(type, name) {
  if (type === "folder") return { id: "icon-folder", class: "folder-icon" };
  const ext = String(name).split(".").pop().toLowerCase();
  return ICON_MAP[ext] || { id: "icon-file", class: "file-icon" };
}
function sortItems(items, field, direction) {
  const sorted = [...items];
  const mul = direction === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    if (field === "name") return mul * a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
    if (field === "size") return mul * ((a.size_bytes || 0) - (b.size_bytes || 0));
    if (field === "type") return mul * getFileType(a.name).localeCompare(getFileType(b.name), "zh-CN", { sensitivity: "base" });
    if (field === "date") return mul * (a.modified || "").localeCompare(b.modified || "");
    return 0;
  });
  return sorted;
}
function showToast(message, type = "success") {
  const toast = document.createElement("div");
  let iconClass = "check-circle";
  let toastClass = "";
  if (type === "delete") {
    iconClass = "trash-alt";
    toastClass = "delete";
  } else if (type === "error") {
    iconClass = "exclamation-circle";
    toastClass = "error";
  } else if (type === "warning") {
    iconClass = "exclamation-triangle";
    toastClass = "warning";
  } else {
    toastClass = "success";
  }
  toast.className = "ai-toast" + (toastClass ? " " + toastClass : "");
  toast.innerHTML = `<i class="fas fa-${iconClass}"></i> ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = "toastOut 0.3s ease-in forwards";
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}
function showRemoteModeTip() {
  const tip = document.createElement("div");
  tip.className = "toast";
  tip.style.background = "linear-gradient(135deg, #f59e0b, #d97706)";
  tip.style.boxShadow = "0 8px 25px rgba(245, 158, 11, 0.3)";
  tip.innerHTML = '<i class="fas fa-info-circle"></i> 远程模式下暂不支持打开文件，请下载后查看';
  document.body.appendChild(tip);
  setTimeout(() => {
    tip.style.animation = "toastOut 0.3s ease-in forwards";
    setTimeout(() => tip.remove(), 300);
  }, 2500);
}
function pathIsInside(current, target) {
  const cur = normalizePath(current || "");
  const tgt = normalizePath(target || "");
  if (!tgt) return cur === "";
  if (cur === tgt) return true;
  const sep = cur.includes("\\") ? "\\" : "/";
  return cur.startsWith(tgt.replace(/[\\/]+$/, "") + sep);
}
function iconForQuick(name) {
  if (name === "下载") return "icon-download";
  if (name === "桌面") return "icon-desktop";
  return "icon-folder";
}
function Sidebar({ remoteMode, curPath, project, quick, drives, roots, onHome, onNavigate }) {
  const isActive = (target) => pathIsInside(curPath, target);
  return /* @__PURE__ */ React.createElement("div", { className: "sidebar" }, /* @__PURE__ */ React.createElement("div", { className: "sidebar-header" }, /* @__PURE__ */ React.createElement("div", { className: "logo-icon" }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-folder-open" }))), /* @__PURE__ */ React.createElement("span", { className: "logo-text" }, "文件浏览器")), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minHeight: 0, overflowY: "auto" } }, /* @__PURE__ */ React.createElement("div", { className: "nav-section" }, /* @__PURE__ */ React.createElement("div", { className: "nav-label" }, "快速访问"), project && /* @__PURE__ */ React.createElement("button", { className: `nav-item${isActive(project) ? " active" : ""}`, title: project, onClick: () => onNavigate(project) }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-project" })), " 项目目录"), quick.map((q) => /* @__PURE__ */ React.createElement("button", { key: q.path, className: `nav-item${isActive(q.path) ? " active" : ""}`, title: q.path, onClick: () => onNavigate(q.path) }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#" + iconForQuick(q.name) })), q.name))), roots && roots.length > 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "ai-divider", style: { margin: "6px 8px" } }), /* @__PURE__ */ React.createElement("div", { className: "nav-section" }, /* @__PURE__ */ React.createElement("div", { className: "nav-label" }, "自定义根"), roots.map((r) => /* @__PURE__ */ React.createElement("button", { key: r.path, className: `nav-item${isActive(r.path) ? " active" : ""}`, title: r.path, onClick: () => onNavigate(r.path) }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-folder" })), /* @__PURE__ */ React.createElement("span", null, r.name))))), /* @__PURE__ */ React.createElement("div", { className: "ai-divider", style: { margin: "6px 8px" } }), /* @__PURE__ */ React.createElement("div", { className: "nav-section" }, /* @__PURE__ */ React.createElement("div", { className: "nav-label" }, "磁盘驱动器"), /* @__PURE__ */ React.createElement("button", { className: `nav-item${isActive("") ? " active" : ""}`, onClick: onHome }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-home" })), " 此电脑"), drives.map((d) => /* @__PURE__ */ React.createElement("button", { key: d.path, className: `nav-item${isActive(d.path) ? " active" : ""}`, title: d.path, onClick: () => onNavigate(d.path) }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-drive" })), /* @__PURE__ */ React.createElement("span", null, d.name))))), /* @__PURE__ */ React.createElement("div", { className: `mode-indicator${remoteMode ? " remote" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "mode-dot" }), /* @__PURE__ */ React.createElement("span", { className: "mode-text" }, remoteMode ? "远程模式" : "本机模式"), /* @__PURE__ */ React.createElement("span", { className: "mode-badge" }, remoteMode ? "远程" : "本地")));
}
function Toolbar({ crumbs, onNavigate, searchText, onSearch, viewMode, onViewMode, onNewFolder, onToggleSidebar, sizeMode, onCycleSize, theme, onCycleTheme, canGoBack, canGoForward, onGoBack, onGoForward, onGoUp }) {
  const curStyle = { background: "white", color: "#0b1e33", fontWeight: 600 };
  const separator = (crumbs || "").includes("\\") ? "\\" : "/";
  let breadcrumbNodes;
  if (!crumbs) {
    breadcrumbNodes = /* @__PURE__ */ React.createElement("span", { className: "breadcrumb-item", style: curStyle, onClick: () => onNavigate("") }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-home" })), " 此电脑");
  } else {
    const parts = String(crumbs).split(separator).filter(Boolean);
    const nodes = [
      /* @__PURE__ */ React.createElement("span", { key: "root", className: "breadcrumb-item", onClick: () => onNavigate("") }, "此电脑"),
      /* @__PURE__ */ React.createElement("span", { key: "sep0", className: "breadcrumb-separator" }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-chevron-right" })))
    ];
    let fullPath = "";
    parts.forEach((part, idx) => {
      fullPath += (fullPath ? separator : "") + part;
      const crumbPath = fullPath;
      const isLast = idx === parts.length - 1;
      nodes.push(
        /* @__PURE__ */ React.createElement("span", { key: "c" + idx, className: "breadcrumb-item", style: isLast ? curStyle : void 0, onClick: () => onNavigate(crumbPath) }, part)
      );
      if (!isLast) {
        nodes.push(/* @__PURE__ */ React.createElement("span", { key: "s" + idx, className: "breadcrumb-separator" }, /* @__PURE__ */ React.createElement("svg", null, /* @__PURE__ */ React.createElement("use", { href: "#icon-chevron-right" }))));
      }
    });
    breadcrumbNodes = nodes;
  }
  return /* @__PURE__ */ React.createElement("div", { className: "toolbar" }, /* @__PURE__ */ React.createElement("div", { className: "nav-controls" }, /* @__PURE__ */ React.createElement("button", { className: "nav-ctrl-btn", disabled: !canGoBack, title: "后退", onClick: onGoBack }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", fill: "currentColor", viewBox: "0 0 16 16" }, /* @__PURE__ */ React.createElement("path", { d: "M10 3L5 8l5 5V3z" }))), /* @__PURE__ */ React.createElement("button", { className: "nav-ctrl-btn", disabled: !canGoForward, title: "前进", onClick: onGoForward }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", fill: "currentColor", viewBox: "0 0 16 16" }, /* @__PURE__ */ React.createElement("path", { d: "M6 3l5 5-5 5V3z" }))), /* @__PURE__ */ React.createElement("button", { className: "nav-ctrl-btn", title: "向上", onClick: onGoUp }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", fill: "currentColor", viewBox: "0 0 16 16" }, /* @__PURE__ */ React.createElement("path", { d: "M8 3l5 5h-3v5H6V8H3l5-5z" })))), /* @__PURE__ */ React.createElement("div", { className: "breadcrumb" }, breadcrumbNodes), /* @__PURE__ */ React.createElement("div", { className: "toolbar-right" }, /* @__PURE__ */ React.createElement("button", { className: "view-btn sidebar-toggle-btn", title: "菜单", onClick: onToggleSidebar }, /* @__PURE__ */ React.createElement("i", { className: "fa-solid fa-bars" })), /* @__PURE__ */ React.createElement("div", { className: "search-box" }, /* @__PURE__ */ React.createElement("i", { className: "fa-solid fa-magnifying-glass" }), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "text",
      placeholder: "搜索文件...",
      value: searchText,
      onChange: (e) => onSearch(e.target.value)
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "view-toggle" }, /* @__PURE__ */ React.createElement("button", { className: `view-btn${viewMode === "list" ? " active" : ""}`, title: "列表视图", onClick: () => onViewMode("list") }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", fill: "currentColor", viewBox: "0 0 16 16" }, /* @__PURE__ */ React.createElement("path", { d: "M0 2h16v2H0V2zm0 4h16v2H0V6zm0 4h16v2H0v-2zm0 4h16v2H0v-2z" }))), /* @__PURE__ */ React.createElement("button", { className: `view-btn${viewMode === "grid" ? " active" : ""}`, title: "卡片视图", onClick: () => onViewMode("grid") }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", fill: "currentColor", viewBox: "0 0 16 16" }, /* @__PURE__ */ React.createElement("path", { d: "M1 1h6v6H1V1zm8 0h6v6H9V1zM1 9h6v6H1V9zm8 0h6v6H9V9z" })))), /* @__PURE__ */ React.createElement("button", { className: "view-btn", title: "新建文件夹", onClick: onNewFolder }, /* @__PURE__ */ React.createElement("i", { className: "fa-solid fa-folder-plus" })), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "view-btn theme-btn",
      title: theme === "win10" ? "当前:Win10 主题(点击:现代)" : "当前:现代主题(点击:Win10)",
      onClick: onCycleTheme
    },
    /* @__PURE__ */ React.createElement("i", { className: `fa-solid ${theme === "win10" ? "fa-desktop" : "fa-palette"}` }),
    /* @__PURE__ */ React.createElement("span", { className: "theme-mode-label" }, theme === "win10" ? "Win10" : "现代")
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "view-btn size-mode-btn",
      title: sizeMode === "view" ? "视图大小(点击:整个视图)" : sizeMode === "whole" ? "整个视图(点击:全屏)" : "全屏(点击:视图大小)",
      onClick: onCycleSize
    },
    /* @__PURE__ */ React.createElement("i", { className: `fa-solid ${sizeMode === "view" ? "fa-window-restore" : sizeMode === "whole" ? "fa-expand-arrows-alt" : "fa-compress"}` }),
    /* @__PURE__ */ React.createElement("span", { className: "size-mode-label" }, sizeMode === "view" ? "视图大小" : sizeMode === "whole" ? "整个视图" : "全屏")
  )));
}
const SORT_DEFS = [
  { field: "name", label: "名称", col: "col-name" },
  { field: "date", label: "修改日期", col: "col-date" },
  { field: "type", label: "类型", col: "col-type" },
  { field: "size", label: "大小", col: "col-size" }
];
function ListHeader({ sort, onSort }) {
  return /* @__PURE__ */ React.createElement("div", { className: "list-header" }, SORT_DEFS.map((s) => /* @__PURE__ */ React.createElement("span", { key: s.field, className: `sortable ${s.col}`, onClick: () => onSort(s.field) }, s.label, /* @__PURE__ */ React.createElement("span", { className: `sort-icon${sort.field === s.field ? " active" : ""}` }, sort.field === s.field ? sort.direction === "asc" ? "↑" : "↓" : ""))));
}
function ItemIcon({ item, thumbSize, thumbClass, onPreview }) {
  const [failed, setFailed] = useState(false);
  if (item.type === "folder" || item.type === "parent") {
    return /* @__PURE__ */ React.createElement("svg", { className: "folder-icon" }, /* @__PURE__ */ React.createElement("use", { href: "#icon-folder" }));
  }
  if (isImage(item.name) && !failed) {
    return /* @__PURE__ */ React.createElement(
      "img",
      {
        className: thumbClass,
        src: buildApiUrl("thumbnail", { path: getFullPath(item.path || item.name), size: thumbSize }),
        alt: item.name,
        loading: "lazy",
        style: { cursor: "zoom-in" },
        onClick: (e) => onPreview(item, e),
        onError: () => setFailed(true)
      }
    );
  }
  const icon = getFileIcon(item.type, item.name);
  return /* @__PURE__ */ React.createElement("svg", { className: icon.class }, /* @__PURE__ */ React.createElement("use", { href: "#" + icon.id }));
}
function FileRow({ item, rename, highlightPath, onRenameChange, onRenameCommit, onRenameCancel, onOpen, onContext, onPreview, onDownload }) {
  const isRenaming = !!(rename && rename.item === item);
  const isParent = item.type === "parent";
  const highlighted = !!highlightPath && getFullPath(item.path || item.name) === highlightPath;
  const hlStyle = { background: "rgba(16, 185, 129, 0.2)", padding: "2px 8px", borderRadius: "4px" };
  const size = isParent ? "—" : item.type === "folder" ? "—" : item.size || "—";
  const fileType = isParent ? "—" : item.type === "folder" ? "文件夹" : getFileType(item.name);
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "file-row",
      "data-type": item.type,
      "data-path": item.path || item.name,
      onClick: isParent ? () => onOpen(item) : void 0,
      onDoubleClick: () => onOpen(item),
      onContextMenu: (e) => onContext(e, item)
    },
    /* @__PURE__ */ React.createElement("div", { className: "name-cell" }, /* @__PURE__ */ React.createElement(ItemIcon, { item, thumbSize: 64, thumbClass: "file-thumb", onPreview }), /* @__PURE__ */ React.createElement("span", { style: highlighted ? hlStyle : void 0 }, isRenaming ? /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "rename-input",
        value: rename.value,
        autoFocus: true,
        ref: (el) => el && el.select(),
        onChange: (e) => onRenameChange(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") onRenameCommit(rename);
          if (e.key === "Escape") onRenameCancel();
        },
        onBlur: () => onRenameCommit(rename)
      }
    ) : item.name, isRenaming && rename.error && /* @__PURE__ */ React.createElement("div", { className: "rename-error" }, rename.error)), item.type === "file" && !isRenaming && /* @__PURE__ */ React.createElement("div", { className: "file-actions" }, /* @__PURE__ */ React.createElement("button", { className: "btn-action", onClick: (e) => onDownload(item, e) }, "下载"))),
    /* @__PURE__ */ React.createElement("div", { className: "date-cell" }, isParent ? "—" : item.modified || "—"),
    /* @__PURE__ */ React.createElement("div", { className: "type-cell" }, fileType),
    /* @__PURE__ */ React.createElement("div", { className: "size-cell" }, size)
  );
}
function FileCard({ item, rename, highlightPath, onRenameChange, onRenameCommit, onRenameCancel, onOpen, onContext, onPreview, onDownload }) {
  const isRenaming = !!(rename && rename.item === item);
  const highlighted = !!highlightPath && getFullPath(item.path || item.name) === highlightPath;
  const hlStyle = { background: "rgba(16, 185, 129, 0.2)", padding: "2px 8px", borderRadius: "4px" };
  const info = item.type === "folder" ? "文件夹" : item.type === "parent" ? "—" : item.size || "—";
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "file-card",
      "data-type": item.type,
      "data-path": item.path || item.name,
      onClick: item.type === "parent" ? () => onOpen(item) : void 0,
      onDoubleClick: () => onOpen(item),
      onContextMenu: (e) => onContext(e, item)
    },
    /* @__PURE__ */ React.createElement("div", { className: "card-icon" }, /* @__PURE__ */ React.createElement(ItemIcon, { item, thumbSize: 96, thumbClass: "card-thumb", onPreview })),
    /* @__PURE__ */ React.createElement("div", { className: "card-name", style: highlighted ? hlStyle : void 0 }, isRenaming ? /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "rename-input",
        value: rename.value,
        autoFocus: true,
        ref: (el) => el && el.select(),
        onChange: (e) => onRenameChange(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") onRenameCommit(rename);
          if (e.key === "Escape") onRenameCancel();
        },
        onBlur: () => onRenameCommit(rename)
      }
    ) : item.name, isRenaming && rename.error && /* @__PURE__ */ React.createElement("div", { className: "rename-error" }, rename.error)),
    /* @__PURE__ */ React.createElement("div", { className: "card-info" }, info),
    item.type === "file" && !isRenaming && /* @__PURE__ */ React.createElement("div", { className: "card-actions" }, /* @__PURE__ */ React.createElement("button", { className: "btn-action", onClick: (e) => onDownload(item, e) }, "下载"))
  );
}
function parentOf(cur) {
  if (!cur) return "";
  const sep = cur.includes("\\") ? "\\" : "/";
  const t = String(cur).replace(/[\\/]+$/, "");
  const idx = t.lastIndexOf(sep);
  if (idx < 0) return "";
  if (idx === 0) return sep;
  return t.slice(0, idx);
}
function FileList({
  data,
  items,
  viewMode,
  searching,
  searchLoading,
  searchResults,
  loading,
  loadError,
  rename,
  highlightPath,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onOpen,
  onContext,
  onPreview,
  onDownload
}) {
  if (searchLoading) return /* @__PURE__ */ React.createElement("div", { className: "file-list" }, /* @__PURE__ */ React.createElement("div", { className: "loading" }, "搜索中..."));
  if (loading) return /* @__PURE__ */ React.createElement("div", { className: "file-list" }, /* @__PURE__ */ React.createElement("div", { className: "loading" }, "加载中..."));
  if (loadError) return /* @__PURE__ */ React.createElement("div", { className: "file-list" }, /* @__PURE__ */ React.createElement("div", { className: "empty-folder" }, loadError));
  if (searching) {
    if (!searchResults.length) return /* @__PURE__ */ React.createElement("div", { className: "file-list" }, /* @__PURE__ */ React.createElement("div", { className: "empty-folder" }, "未找到匹配的文件"));
    return /* @__PURE__ */ React.createElement("div", { className: "file-list" }, /* @__PURE__ */ React.createElement("div", { style: { padding: "10px", color: "#64748b", fontSize: "14px" } }, "找到 ", searchResults.length, " 个结果"), searchResults.map((item) => /* @__PURE__ */ React.createElement(
      FileRow,
      {
        key: item.path,
        item,
        rename,
        highlightPath,
        onRenameChange,
        onRenameCommit,
        onRenameCancel,
        onOpen,
        onContext,
        onPreview,
        onDownload
      }
    )));
  }
  const showParent = data && data.parent_path !== void 0 && data.parent_path !== data.current_path;
  const parentItem = showParent ? { name: ".. (返回上级)", path: parentOf(data.current_path), type: "parent" } : null;
  if (viewMode === "grid") {
    return /* @__PURE__ */ React.createElement("div", { className: "file-list" }, /* @__PURE__ */ React.createElement("div", { className: "file-grid" }, parentItem && /* @__PURE__ */ React.createElement(FileCard, { key: "parent", item: parentItem, rename: null, highlightPath: "", onOpen, onContext, onPreview, onDownload }), items.map((item) => /* @__PURE__ */ React.createElement(
      FileCard,
      {
        key: item.path,
        item,
        rename,
        highlightPath,
        onRenameChange,
        onRenameCommit,
        onRenameCancel,
        onOpen,
        onContext,
        onPreview,
        onDownload
      }
    ))), !items.length && /* @__PURE__ */ React.createElement("div", { className: "empty-folder" }, "此文件夹为空"));
  }
  return /* @__PURE__ */ React.createElement("div", { className: "file-list" }, parentItem && /* @__PURE__ */ React.createElement(FileRow, { key: "parent", item: parentItem, rename: null, highlightPath: "", onOpen, onContext, onPreview, onDownload }), items.map((item) => /* @__PURE__ */ React.createElement(
    FileRow,
    {
      key: item.path,
      item,
      rename,
      highlightPath,
      onRenameChange,
      onRenameCommit,
      onRenameCancel,
      onOpen,
      onContext,
      onPreview,
      onDownload
    }
  )), !items.length && /* @__PURE__ */ React.createElement("div", { className: "empty-folder" }, "此文件夹为空"));
}
function ContextMenu({ menu, remoteMode, menuRef, onOpen, onOpenLocation, onAnalyze, onCopy, onRename, onDelete, onProperty }) {
  const item = menu ? menu.item : null;
  const isParent = !!(item && item.type === "parent");
  return /* @__PURE__ */ React.createElement("div", { className: `context-menu${menu ? " active" : ""}`, ref: menuRef, style: menu ? { left: menu.x, top: menu.y } : void 0 }, /* @__PURE__ */ React.createElement("div", { className: "context-menu-item", onClick: onOpen }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-folder-open" }), /* @__PURE__ */ React.createElement("span", null, "打开")), /* @__PURE__ */ React.createElement("div", { className: `context-menu-item${remoteMode ? " disabled" : ""}`, onClick: onOpenLocation }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-external-link-alt" }), /* @__PURE__ */ React.createElement("span", null, "打开所在目录")), /* @__PURE__ */ React.createElement("div", { className: `context-menu-item${remoteMode ? " disabled" : ""}`, onClick: onAnalyze }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-robot" }), /* @__PURE__ */ React.createElement("span", null, "一键AI分析")), /* @__PURE__ */ React.createElement("div", { className: `context-menu-item${remoteMode || isParent ? " disabled" : ""}`, onClick: onCopy }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-copy" }), /* @__PURE__ */ React.createElement("span", null, "复制")), /* @__PURE__ */ React.createElement("div", { className: "context-menu-divider" }), /* @__PURE__ */ React.createElement("div", { className: `context-menu-item${isParent ? " disabled" : ""}`, onClick: onRename }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-edit" }), /* @__PURE__ */ React.createElement("span", null, "重命名")), /* @__PURE__ */ React.createElement("div", { className: `context-menu-item${isParent ? " disabled" : ""}`, onClick: onDelete }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-trash-alt" }), /* @__PURE__ */ React.createElement("span", null, "删除")), /* @__PURE__ */ React.createElement("div", { className: "context-menu-divider" }), /* @__PURE__ */ React.createElement("div", { className: "context-menu-item", onClick: onProperty }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-info-circle" }), /* @__PURE__ */ React.createElement("span", null, "属性")));
}
const TEXT_PREVIEW_EXTS = ["txt", "md", "markdown", "json", "js", "jsx", "ts", "tsx", "py", "html", "htm", "css", "xml", "yml", "yaml", "log", "csv", "ini", "conf", "sh", "bat", "ps1", "env", "gitignore"];
function isTextPreview(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return TEXT_PREVIEW_EXTS.indexOf(ext) !== -1;
}
function PreviewOverlay({ preview, onClose }) {
  const [text, setText] = useState(null);
  const [textError, setTextError] = useState(null);
  const isText = !!(preview && isTextPreview(preview.name));
  useEffect(() => {
    if (!isText) {
      setText(null);
      setTextError(null);
      return;
    }
    let cancelled = false;
    apiGet("read", { path: preview.path }).then((data) => {
      if (cancelled) return;
      setText(data.content);
      setTextError(null);
    }).catch((err) => {
      if (cancelled) return;
      setText(null);
      setTextError(err && err.message || String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [preview, isText]);
  if (!preview) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "preview-overlay active", onClick: onClose }, /* @__PURE__ */ React.createElement("button", { className: "preview-close", onClick: onClose }, "×"), isText ? textError ? /* @__PURE__ */ React.createElement("div", { className: "preview-text preview-error", onClick: (e) => e.stopPropagation() }, textError) : text === null ? /* @__PURE__ */ React.createElement("div", { className: "preview-text preview-loading" }, "加载中…") : /* @__PURE__ */ React.createElement("pre", { className: "preview-text", onClick: (e) => e.stopPropagation() }, text) : /* @__PURE__ */ React.createElement("img", { src: buildApiUrl("download", { path: preview.path }), alt: preview.name }), /* @__PURE__ */ React.createElement("div", { className: "preview-info" }, preview.name));
}
function ConfirmDialog({ item, onCancel, onConfirm }) {
  if (!item) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "confirm-dialog active", onClick: onCancel }, /* @__PURE__ */ React.createElement("div", { className: "dialog-box", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "dialog-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24" }, /* @__PURE__ */ React.createElement("path", { d: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" }))), /* @__PURE__ */ React.createElement("div", { className: "dialog-title" }, "确认删除"), /* @__PURE__ */ React.createElement("div", { className: "dialog-message" }, '确定要删除 "', item.name, '" 吗？此操作无法撤销。'), /* @__PURE__ */ React.createElement("div", { className: "dialog-actions" }, /* @__PURE__ */ React.createElement("button", { className: "dialog-btn dialog-btn-cancel", onClick: onCancel }, "取消"), /* @__PURE__ */ React.createElement("button", { className: "dialog-btn dialog-btn-danger", onClick: onConfirm }, "删除"))));
}
function PropertyDialog({ item, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!item) return null;
  const isFolder = item.type === "folder";
  const isImg = !isFolder && isImage(item.name);
  const iconClass = isFolder ? "folder" : isImg ? "image" : "file";
  const iconPath = isFolder ? "M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" : isImg ? "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" : "M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm0 2h7v5h5v11H6V4z";
  const fullPath = getFullPath(item.path || item.name);
  const copyPath = () => {
    navigator.clipboard.writeText(fullPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2e3);
    }).catch(() => showToast("复制失败", "error"));
  };
  return /* @__PURE__ */ React.createElement("div", { className: "property-dialog active", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "dialog-box", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "dialog-header" }, /* @__PURE__ */ React.createElement("div", { className: `dialog-icon ${iconClass}` }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24" }, /* @__PURE__ */ React.createElement("path", { d: iconPath }))), /* @__PURE__ */ React.createElement("div", { className: "file-name" }, item.name)), /* @__PURE__ */ React.createElement("div", { className: "property-grid" }, /* @__PURE__ */ React.createElement("div", { className: "property-label" }, "类型"), /* @__PURE__ */ React.createElement("div", { className: "property-value" }, isFolder ? "文件夹" : getFileType(item.name)), /* @__PURE__ */ React.createElement("div", { className: "property-label" }, "大小"), /* @__PURE__ */ React.createElement("div", { className: "property-value" }, isFolder ? "—" : item.size || "—"), /* @__PURE__ */ React.createElement("div", { className: "property-label" }, "修改日期"), /* @__PURE__ */ React.createElement("div", { className: "property-value" }, item.modified || "—"), /* @__PURE__ */ React.createElement("div", { className: "property-label" }, "路径"), /* @__PURE__ */ React.createElement("div", { className: "property-value path-value" }, /* @__PURE__ */ React.createElement("span", { className: "path-text" }, fullPath), /* @__PURE__ */ React.createElement("button", { className: `copy-btn${copied ? " copied" : ""}`, onClick: copyPath }, copied ? "已复制" : "复制"))), /* @__PURE__ */ React.createElement("div", { className: "dialog-footer" }, /* @__PURE__ */ React.createElement("button", { className: "dialog-btn", onClick: onClose }, "关闭"))));
}
function NewFolderDialog({ open, onClose, onCreate }) {
  const [name, setName] = useState("");
  if (!open) return null;
  const submit = () => onCreate(name.trim());
  return /* @__PURE__ */ React.createElement("div", { className: "modal-overlay active", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "modal-header" }, /* @__PURE__ */ React.createElement("div", { className: "modal-title" }, "新建文件夹"), /* @__PURE__ */ React.createElement("button", { className: "modal-close", onClick: onClose }, "×")), /* @__PURE__ */ React.createElement("div", { className: "modal-body" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "ai-form-input",
      placeholder: "输入文件夹名称",
      value: name,
      autoFocus: true,
      onChange: (e) => setName(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") onClose();
      }
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "modal-footer" }, /* @__PURE__ */ React.createElement("button", { className: "modal-btn modal-btn-cancel", onClick: onClose }, "取消"), /* @__PURE__ */ React.createElement("button", { className: "modal-btn modal-btn-download", onClick: submit }, "创建"))));
}
function AnalyzeDialog({ item, onClose, onStart }) {
  const [requirement, setRequirement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!item) return null;
  const submit = async () => {
    const text = requirement.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      await onStart(text);
      onClose();
    } catch (e) {
      setError(e.message || "启动失败");
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React.createElement("div", { className: "modal-overlay active", onClick: busy ? void 0 : onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "modal-header" }, /* @__PURE__ */ React.createElement("div", { className: "modal-title" }, "一键AI分析"), /* @__PURE__ */ React.createElement("button", { className: "modal-close", onClick: onClose, disabled: busy }, "×")), /* @__PURE__ */ React.createElement("div", { className: "modal-body" }, /* @__PURE__ */ React.createElement("div", { className: "analyze-target", title: item.path || item.name }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-robot" }), /* @__PURE__ */ React.createElement("span", null, item.name)), /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "ai-form-input analyze-input",
      placeholder: "输入你的需求，例如：分析这个项目的技术架构和代码质量",
      value: requirement,
      autoFocus: true,
      rows: 5,
      onChange: (e) => setRequirement(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
        if (e.key === "Escape") onClose();
      }
    }
  ), error && /* @__PURE__ */ React.createElement("div", { className: "analyze-error" }, error)), /* @__PURE__ */ React.createElement("div", { className: "modal-footer" }, /* @__PURE__ */ React.createElement("button", { className: "modal-btn modal-btn-cancel", onClick: onClose, disabled: busy }, "取消"), /* @__PURE__ */ React.createElement("button", { className: "modal-btn modal-btn-download", onClick: submit, disabled: busy || !requirement.trim() }, busy ? "启动中..." : "开始分析"))));
}
function loadViewMode() {
  try {
    return localStorage.getItem("fileBrowserViewMode") || "list";
  } catch (e) {
    return "list";
  }
}
function saveViewMode(mode) {
  try {
    localStorage.setItem("fileBrowserViewMode", mode);
  } catch (e) {
  }
}
function App() {
  const [remoteMode, setRemoteMode] = useState(false);
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [curPath, setCurPath] = useState("");
  const [sidebarData, setSidebarData] = useState({ project: null, quick: [], drives: [] });
  const [viewMode, setViewMode] = useState(loadViewMode);
  const [sort, setSort] = useState({ field: "name", direction: "asc" });
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [ctxMenu, setCtxMenu] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [propertyItem, setPropertyItem] = useState(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [analyzeItem, setAnalyzeItem] = useState(null);
  const [rename, setRename] = useState(null);
  const [highlightPath, setHighlightPath] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sizeMode, setSizeMode] = useState("view");
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("agfs-theme") || "modern";
    } catch (e) {
      return "modern";
    }
  });
  const searchTimer = useRef(null);
  const menuRef = useRef(null);
  const renameRef = useRef(null);
  const renamingBusyRef = useRef(false);
  const loadDirRef = useRef(null);
  const navStackRef = useRef([""]);
  const navIndexRef = useRef(0);
  const [navIndex, setNavIndex] = useState(0);
  const loadDirectory = useCallback(async (path, push = true) => {
    setLoading(true);
    setLoadError("");
    setSearchLoading(false);
    setSearching(false);
    setSearchResults([]);
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set("path", path);
    history.pushState({ path }, "", newUrl);
    filepath = new URLSearchParams(window.location.search).get("path") || "";
    currentPath = path;
    setCurPath(path);
    setSidebarOpen(false);
    if (push) {
      const stack = navStackRef.current;
      const next = [...stack.slice(0, navIndexRef.current + 1), path];
      navStackRef.current = next;
      navIndexRef.current = next.length - 1;
      setNavIndex(navIndexRef.current);
    }
    try {
      const result = await apiGet("list", { path });
      setData(result);
      setItems(sortItems(result.items, sort.field, sort.direction));
    } catch (e) {
      console.error("加载目录失败:", e);
      setData(null);
      setItems([]);
      setLoadError(e.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [sort.field, sort.direction]);
  loadDirRef.current = loadDirectory;
  renameRef.current = rename;
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
      setLoadError("");
      try {
        const result = await apiGet("search", { path: currentPath, keyword });
        setSearching(true);
        setSearchResults(result.results || []);
      } catch (e) {
        console.error("搜索失败:", e);
        setLoadError(e.message || "搜索失败");
      } finally {
        setSearchLoading(false);
      }
    }, 500);
  };
  const handleSort = (field) => {
    const next = sort.field === field ? { field, direction: sort.direction === "asc" ? "desc" : "asc" } : { field, direction: "asc" };
    setSort(next);
    setItems(sortItems(items, next.field, next.direction));
  };
  const handleViewMode = (mode) => {
    setViewMode(mode);
    saveViewMode(mode);
  };
  const openFileInSystem = async (path) => {
    try {
      const res = await fetch(buildApiUrl("open", { path }));
      const result = await res.json();
      if (!result.success) showToast("打开失败: " + result.error, "error");
    } catch (e) {
      showToast("打开失败: " + e.message, "error");
    }
  };
  const openItem = (item) => {
    if (!item) return;
    if (item.type === "folder" || item.type === "parent") {
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
  const previewOpen = (item, e) => {
    if (e) e.stopPropagation();
    setPreview({ path: getFullPath(item.path || item.name), name: item.name });
  };
  const doDownload = (item, e) => {
    if (e) e.stopPropagation();
    window.open(buildApiUrl("download", { path: getFullPath(item.path || item.name) }), "_blank");
  };
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
      const res = await fetch(buildApiUrl("open_location", { path }));
      const result = await res.json();
      if (!result.success) showToast("打开失败: " + result.error, "error");
    } catch (e) {
      showToast("打开失败: " + e.message, "error");
    }
  };
  const openLocalManager = async () => {
    if (remoteMode) return;
    const path = currentPath || data && data.root_path || "";
    try {
      const res = await fetch(buildApiUrl("open_location", { path }));
      const result = await res.json();
      if (!result.success) {
        showToast("打开失败: " + (result.error || "未知错误"), "error");
      } else {
        showToast("已打开本地文件管理器", "success");
      }
    } catch (e) {
      showToast("打开失败: " + e.message, "error");
    }
  };
  const startAnalysis = async (requirement) => {
    const item = analyzeItem;
    if (!item || remoteMode) return;
    const path = getFullPath(item.path || item.name);
    const res = await fetch(buildApiUrl("analyze", {}), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, requirement })
    });
    const result = await res.json().catch(() => ({ success: false, error: "响应解析失败" }));
    if (!result.success) throw new Error(result.error || "分析启动失败");
    showToast("分析已启动，请在 dsh 对话框中查看", "success");
  };
  const ctxCopy = async () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    if (!item || remoteMode || item.type === "parent") return;
    const srcPath = getFullPath(item.path || item.name);
    const newName = `复件_${item.name}`;
    const destPath = getFullPath(newName);
    try {
      const result = await apiPost("copy", { path: srcPath, dest_path: destPath });
      const newItem = {
        ...item,
        name: newName,
        path: result.dest_path || destPath,
        modified: (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace("T", " ")
      };
      setItems((prev) => [newItem, ...prev]);
      setHighlightPath(newItem.path);
      setTimeout(() => setHighlightPath(""), 1500);
      showToast("复制成功");
    } catch (e) {
      alert("复制失败: " + e.message);
    }
  };
  const ctxDelete = () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    if (item && item.type !== "parent") setConfirmTarget(item);
  };
  const ctxProperty = () => {
    const item = ctxMenu && ctxMenu.item;
    setCtxMenu(null);
    if (item) setPropertyItem(item);
  };
  const startRename = (item) => setRename({ item, value: item.name, error: "" });
  const commitRename = async (r) => {
    if (renamingBusyRef.current) return;
    if (!r || renameRef.current !== r) return;
    const oldName = r.item.name;
    const ext = oldName.includes(".") ? "." + oldName.split(".").pop() : "";
    const newBaseName = r.value.trim();
    const newName = newBaseName.includes(".") ? newBaseName : newBaseName + ext;
    if (!newBaseName) {
      setRename({ ...r, error: "文件名不能为空" });
      return;
    }
    const illegal = ["<", ">", ":", '"', "/", "\\", "|", "?", "*"];
    for (const ch of illegal) {
      if (newName.includes(ch)) {
        setRename({ ...r, error: `文件名不能包含: ${ch}` });
        return;
      }
    }
    renamingBusyRef.current = true;
    try {
      const result = await apiPost("rename", { path: getFullPath(r.item.path || r.item.name), new_name: newName });
      if (renameRef.current !== r) return;
      const newPath = result.new_path || getFullPath(r.item.path || r.item.name);
      setItems((prev) => prev.map((it) => it === r.item ? { ...it, name: newName, path: newPath } : it));
      if (searching) setSearchResults((prev) => prev.map((it) => it === r.item ? { ...it, name: newName, path: newPath } : it));
      setRename(null);
      setHighlightPath(newPath);
      setTimeout(() => setHighlightPath(""), 1500);
      showToast("重命名成功");
    } catch (e) {
      if (renameRef.current !== r) return;
      setRename({ ...r, error: e.message || "重命名失败" });
    } finally {
      renamingBusyRef.current = false;
    }
  };
  const cancelRename = () => {
    setRename(null);
  };
  const confirmDelete = async () => {
    const item = confirmTarget;
    if (!item) return;
    setConfirmTarget(null);
    try {
      await apiPost("delete", { path: getFullPath(item.path || item.name) });
      setItems((prev) => prev.filter((it) => it !== item));
      setSearchResults((prev) => prev.filter((it) => it !== item));
      showToast("删除成功");
    } catch (e) {
      alert("删除失败: " + e.message);
    }
  };
  const handleCreateFolder = async (name) => {
    if (!name) {
      showToast("请输入文件夹名称", "warning");
      return;
    }
    try {
      const result = await apiPost("create_folder", { path: getFullPath(name) });
      setNewFolderOpen(false);
      await loadDirectory(currentPath);
      setHighlightPath(result.path || getFullPath(name));
      setTimeout(() => setHighlightPath(""), 1500);
      showToast("创建成功");
    } catch (e) {
      showToast("创建失败: " + e.message, "error");
    }
  };
  const toggleSizeMode = () => {
    try {
      if (sizeMode === "view") {
        setSizeMode("whole");
      } else if (sizeMode === "whole") {
        setSizeMode("fullscreen");
        document.documentElement.requestFullscreen().catch(() => {
        });
      } else {
        setSizeMode("view");
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {
        });
      }
    } catch (e) {
    }
  };
  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === "win10" ? "modern" : "win10";
      try {
        localStorage.setItem("agfs-theme", next);
      } catch (e) {
      }
      return next;
    });
  };
  const goBack = () => {
    if (navIndexRef.current <= 0) return;
    navIndexRef.current -= 1;
    setNavIndex(navIndexRef.current);
    loadDirectory(navStackRef.current[navIndexRef.current], false);
  };
  const goForward = () => {
    if (navIndexRef.current >= navStackRef.current.length - 1) return;
    navIndexRef.current += 1;
    setNavIndex(navIndexRef.current);
    loadDirectory(navStackRef.current[navIndexRef.current], false);
  };
  const goUp = () => {
    const sep = (currentPath || "").includes("\\") ? "\\" : "/";
    const parts = currentPath.split(sep).filter(Boolean);
    parts.pop();
    loadDirectory(parts.join(sep));
  };
  useEffect(() => {
    const onFs = () => {
      if (document.fullscreenElement) {
        setSizeMode("fullscreen");
      } else {
        setSizeMode((prev) => prev === "fullscreen" ? "whole" : prev);
      }
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  useEffect(() => {
    document.body.classList.toggle("theme-win10", theme === "win10");
    return () => document.body.classList.remove("theme-win10");
  }, [theme]);
  useEffect(() => {
    const onDocClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setCtxMenu(null);
    };
    const onDocCtx = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target) && !(e.target.closest && e.target.closest(".file-row, .file-card"))) setCtxMenu(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("contextmenu", onDocCtx);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("contextmenu", onDocCtx);
    };
  }, []);
  useEffect(() => {
    if (!ctxMenu || !menuRef.current) return;
    const w = menuRef.current.offsetWidth;
    const h = menuRef.current.offsetHeight;
    let { x, y } = ctxMenu;
    if (x + w > window.innerWidth) x = window.innerWidth - w - 10;
    if (y + h > window.innerHeight) y = window.innerHeight - h - 10;
    if (x !== ctxMenu.x || y !== ctxMenu.y) setCtxMenu({ ...ctxMenu, x, y });
  }, [ctxMenu]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setPreview(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const onPop = (e) => {
      loadDirRef.current(e.state && e.state.path || "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(API_PREFIX + "mode");
        const json = await res.json();
        if (json.success) setRemoteMode(!!json.data.remote_mode);
      } catch (e) {
        console.error("获取模式失败:", e);
      }
      apiGet("sidebar").then((d) => {
        setSidebarData({ project: d && d.project || null, quick: d && d.quick || [], drives: d && d.drives || [] });
      }).catch(() => {
      });
      const initialPath = new URL(window.location.href).searchParams.get("path") || "";
      loadDirRef.current(initialPath);
    })();
    return () => clearTimeout(searchTimer.current);
  }, []);
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: `browser${sidebarOpen ? " sidebar-open" : ""}${sizeMode === "view" ? " size-view" : " size-whole"}${theme === "win10" ? " theme-win10" : ""}` }, theme === "win10" && /* @__PURE__ */ React.createElement("div", { className: "win10-titlebar" }, /* @__PURE__ */ React.createElement("div", { className: "win10-titlebar-title" }, /* @__PURE__ */ React.createElement("svg", { className: "win10-titlebar-logo" }, /* @__PURE__ */ React.createElement("use", { href: "#icon-folder-open" })), /* @__PURE__ */ React.createElement("span", null, "文件浏览器")), /* @__PURE__ */ React.createElement("div", { className: "win10-titlebar-controls" }, /* @__PURE__ */ React.createElement("button", { className: "win10-tb-btn win10-tb-min", title: "最小化" }, /* @__PURE__ */ React.createElement("svg", { width: "10", height: "10", viewBox: "0 0 10 10" }, /* @__PURE__ */ React.createElement("path", { d: "M0 5h10v1H0z", fill: "currentColor" }))), /* @__PURE__ */ React.createElement("button", { className: "win10-tb-btn win10-tb-max", title: "最大化" }, /* @__PURE__ */ React.createElement("svg", { width: "10", height: "10", viewBox: "0 0 10 10" }, /* @__PURE__ */ React.createElement("path", { d: "M0 0h10v10H0z", fill: "none", stroke: "currentColor", strokeWidth: "1" }))), /* @__PURE__ */ React.createElement("button", { className: "win10-tb-btn win10-tb-close", title: "关闭" }, /* @__PURE__ */ React.createElement("svg", { width: "10", height: "10", viewBox: "0 0 10 10" }, /* @__PURE__ */ React.createElement("path", { d: "M0 0l10 10M10 0L0 10", stroke: "currentColor", strokeWidth: "1.2" }))))), /* @__PURE__ */ React.createElement("div", { className: "browser-body" }, /* @__PURE__ */ React.createElement(Sidebar, { remoteMode, curPath, project: sidebarData.project, quick: sidebarData.quick, drives: sidebarData.drives, roots: sidebarData.roots, onHome: () => loadDirectory(""), onNavigate: loadDirectory }), /* @__PURE__ */ React.createElement("div", { className: "sidebar-backdrop", onClick: () => setSidebarOpen(false) }), /* @__PURE__ */ React.createElement("div", { className: "main" }, /* @__PURE__ */ React.createElement(
    Toolbar,
    {
      crumbs: data ? data.current_path : "",
      onNavigate: loadDirectory,
      searchText,
      onSearch: handleSearch,
      viewMode,
      onViewMode: handleViewMode,
      onNewFolder: () => setNewFolderOpen(true),
      onToggleSidebar: () => setSidebarOpen((v) => !v),
      sizeMode,
      onCycleSize: toggleSizeMode,
      theme,
      onCycleTheme: toggleTheme,
      canGoBack: navIndex > 0,
      canGoForward: navIndex < navStackRef.current.length - 1,
      onGoBack: goBack,
      onGoForward: goForward,
      onGoUp: goUp
    }
  ), /* @__PURE__ */ React.createElement(ListHeader, { sort, onSort: handleSort }), /* @__PURE__ */ React.createElement(
    FileList,
    {
      data,
      items,
      viewMode,
      searching,
      searchLoading,
      searchResults,
      loading,
      loadError,
      rename,
      highlightPath,
      onRenameChange: (v) => setRename((prev) => prev ? { ...prev, value: v } : prev),
      onRenameCommit: commitRename,
      onRenameCancel: cancelRename,
      onOpen: openItem,
      onContext: handleContext,
      onPreview: previewOpen,
      onDownload: doDownload
    }
  ), theme === "win10" && /* @__PURE__ */ React.createElement("div", { className: "win10-statusbar" }, /* @__PURE__ */ React.createElement("span", null, items.length, " 个项目"), /* @__PURE__ */ React.createElement("span", { className: "win10-status-right" }, remoteMode ? "远程模式" : "本机模式"))))), /* @__PURE__ */ React.createElement(
    ContextMenu,
    {
      menu: ctxMenu,
      remoteMode,
      menuRef,
      onOpen: ctxOpen,
      onOpenLocation: ctxOpenLocation,
      onAnalyze: () => {
        const it = ctxMenu && ctxMenu.item;
        setCtxMenu(null);
        if (it) setAnalyzeItem(it);
      },
      onCopy: ctxCopy,
      onRename: () => {
        const it = ctxMenu && ctxMenu.item;
        setCtxMenu(null);
        if (it && it.type !== "parent") startRename(it);
      },
      onDelete: ctxDelete,
      onProperty: ctxProperty
    }
  ), !remoteMode && /* @__PURE__ */ React.createElement("button", { className: "open-local-float", onClick: openLocalManager, title: "在本地文件管理器中打开当前目录" }, /* @__PURE__ */ React.createElement("i", { className: "fas fa-folder-open", "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("span", null, "本地打开")), /* @__PURE__ */ React.createElement(PreviewOverlay, { preview, onClose: () => setPreview(null) }), /* @__PURE__ */ React.createElement(ConfirmDialog, { item: confirmTarget, onCancel: () => setConfirmTarget(null), onConfirm: confirmDelete }), /* @__PURE__ */ React.createElement(PropertyDialog, { item: propertyItem, onClose: () => setPropertyItem(null) }), /* @__PURE__ */ React.createElement(NewFolderDialog, { open: newFolderOpen, onClose: () => setNewFolderOpen(false), onCreate: handleCreateFolder }), /* @__PURE__ */ React.createElement(AnalyzeDialog, { item: analyzeItem, onClose: () => setAnalyzeItem(null), onStart: startAnalysis }));
}
ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
