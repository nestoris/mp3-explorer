#!/usr/bin/gjs
/* Mp3-Explorer
 * Совместимо с GJS 1.82.3 / 1.90.1 и CJS 128.1, GTK3.
 */

imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.Gio = '2.0';

const Gtk     = imports.gi.Gtk;
const Gdk     = imports.gi.Gdk;
const GObject = imports.gi.GObject;
const GLib    = imports.gi.GLib;
const Gio     = imports.gi.Gio;
const ByteArray = imports.byteArray;

/* ============================================================
 *  Разбор аргументов командной строки
 * ============================================================ */
const System = imports.system;
const scriptArgs = System.programArgs || [];
let cliRoot = null;
for (const arg of ARGV) {
    if (arg === '--help' || arg === '-h') {
        print("Usage: mp3-explorer.js [PATH]");
        print("  PATH - Root directory to scan for MP3 files");
        imports.system.exit(0);
    } else if (!arg.startsWith('-')) {
        cliRoot = arg;
    }
}
Gtk.init(null);

/* ============================================================
 *  Вспомогательные функции
 * ============================================================ */
function unwrapIter(r) {
    if (r === null || r === undefined || r === false) return null;
    if (Array.isArray(r) && r.length === 2 && typeof r[0] === 'boolean')
        return r[0] ? r[1] : null;
    return r;
}

function unwrapNext(model, iter) {
    const r = model.iter_next(iter);
    if (Array.isArray(r) && typeof r[0] === 'boolean')
        return r[0] ? r[1] : null;
    return r ? iter : null;
}

function getSelected(selection) {
    const r = selection.get_selected();
    if (!r) return [null, null];
    if (Array.isArray(r) && r.length === 3 && typeof r[0] === 'boolean')
        return r[0] ? [r[1], r[2]] : [null, null];
    return [r[0] || null, r[1] || null];
}

function getHitPath(tv, x, y) {
    const r = tv.get_path_at_pos(Math.floor(x), Math.floor(y));
    if (!r) return null;
    if (Array.isArray(r)) {
        if (typeof r[0] === 'boolean') return r[0] ? r[1] : null;
        return r[0] || null;
    }
    if (typeof r.get_indices === 'function') return r;
    return null;
}

function evtButton(event) {
    if (!event) return 0;
    if (typeof event.get_button === 'function') {
        try {
            const r = event.get_button();
            if (Array.isArray(r)) {
                if (typeof r[0] === 'boolean') return r[0] ? (r[1] || 0) : 0;
                if (typeof r[0] === 'number') return r[0];
            }
            if (typeof r === 'number') return r;
        } catch (e) {}
    }
    try {
        const b = event.button;
        if (typeof b === 'number') return b;
        if (Array.isArray(b) && typeof b[0] === 'boolean') return b[0] ? (b[1] || 0) : 0;
    } catch (e) {}
    return 0;
}

function evtKeyval(event) {
    if (!event) return 0;
    if (typeof event.get_keyval === 'function') {
        const r = event.get_keyval();
        if (Array.isArray(r)) return r[0] || 0;
        return r || 0;
    }
    return event.keyval || 0;
}

function evtXY(event) {
    if (!event) return [0, 0];
    if (typeof event.get_coords === 'function') {
        try {
            const r = event.get_coords();
            if (Array.isArray(r)) {
                if (typeof r[0] === 'boolean' && r.length >= 3) return [r[1] || 0, r[2] || 0];
                if (r.length >= 2) return [r[0] || 0, r[1] || 0];
            }
        } catch (e) {}
    }
    try {
        const x = event.x, y = event.y;
        if (typeof x === 'number' && typeof y === 'number') return [x, y];
    } catch (e) {}
    return [0, 0];
}

function popupMenuAtPointer(menu) {
    menu.show_all();
    if (typeof menu.popup_at_pointer === 'function') menu.popup_at_pointer(null);
    else menu.popup(null, null, null, 0, 0);
}

function getSelectedRows(treeView) {
    const sel = treeView.get_selection();
    if (!sel) return [];
    const r = sel.get_selected_rows();
    if (!r) return [];
    let paths = [];
    if (Array.isArray(r)) {
        if (r.length === 2 && (r[0] === null || typeof r[0] === 'object') && Array.isArray(r[1])) {
            paths = r[1];
        } else if (Array.isArray(r[0])) {
            paths = r[0];
        } else {
            paths = r;
        }
    }
    return paths.filter(p => p && typeof p.get_indices === 'function');
}

function getSelectedTracks(treeView, model) {
    const selected = [];
    const paths = getSelectedRows(treeView);
    for (const p of paths) {
        const iter = unwrapIter(model.get_iter(p));
        if (iter) {
            const name = model.get_value(iter, 0);
            const file = model.get_value(iter, 1);
            const dir = model.get_value(iter, 2);
            const fullPath = dir.endsWith('/') ? dir + file : dir + '/' + file;
            selected.push({ name, path: fullPath });
        }
    }
    return selected;
}

/* ============================================================
 *  Конфигурация
 * ============================================================ */
const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'mp3-explorer']);
const CACHE_DIR  = GLib.build_filenamev([GLib.get_user_cache_dir(), 'mp3-explorer']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'config.ini']);
const WINDOW_FILE = GLib.build_filenamev([CONFIG_DIR, 'window.json']);
const PLAYLISTS_FILE = GLib.build_filenamev([CONFIG_DIR, 'playlists.json']);

try { GLib.mkdir_with_parents(CONFIG_DIR, 0o755); } catch (e) {}
try { GLib.mkdir_with_parents(CACHE_DIR, 0o755); } catch (e) {}

if (!GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)) {
    const DEFAULT_CONFIG = `# Настройки Mp3-Explorer

[Paths]
# Корневые каталоги для поиска mp3 (разделяйте точкой с запятой)
Roots=

[Player]
# Команда для проигрывания файла или m3u плейлиста. %f заменится на путь.
Play=

# Команда для добавления в очередь. %f заменится на путь.
Enqueue=

# Если true, выделенные треки (>1) пишутся во временный m3u файл, путь к которому передаётся в %f.
# Полезно для плееров, не поддерживающих несколько файлов в аргументах.
MultipleTracksUseM3U=false
`;
    try { GLib.file_set_contents(CONFIG_FILE, DEFAULT_CONFIG); } catch (e) {}
}

const keyfile = new GLib.KeyFile();
try { keyfile.load_from_file(CONFIG_FILE, GLib.KeyFileFlags.NONE); } catch (e) {}

let rootsStr = '';
try { rootsStr = keyfile.get_string('Paths', 'Roots'); } catch (e) {}
const ROOTS = rootsStr ? rootsStr.split(';').map(s => s.trim()).filter(Boolean) : [];

let cliRootIndex = -1;
if (cliRoot) {
    const absPath = GLib.canonicalize_filename(cliRoot, GLib.get_current_dir());
    if (!ROOTS.includes(absPath)) {
        ROOTS.push(absPath);
    }
    cliRootIndex = ROOTS.indexOf(absPath);
}

function getPlayCommand() {
    try { return keyfile.get_string('Player', 'Play'); } catch (e) { return ''; }
}
function getEnqueueCommand() {
    try { return keyfile.get_string('Player', 'Enqueue'); } catch (e) { return ''; }
}
function getMultipleM3U() {
    try { return keyfile.get_boolean('Player', 'MultipleTracksUseM3U'); } catch (e) { return false; }
}

/* Настройки окна и колонок */
let winConfig = {
    width: 900, height: 600,
    hpaned: 280, vpaned: 360,
    collection: 0,
    fileCols: null,
    playlistCols: null
};
try {
    if (GLib.file_test(WINDOW_FILE, GLib.FileTest.EXISTS)) {
        const [ok, data] = GLib.file_get_contents(WINDOW_FILE);
        if (ok) winConfig = Object.assign(winConfig, JSON.parse(ByteArray.toString(data)));
    }
} catch (e) {}

// --- НОВЫЙ КОД: приоритет у пути из аргументов ---
if (cliRootIndex >= 0) {
    winConfig.collection = cliRootIndex;
}
// ------------------------------------------------
/* ============================================================
 *  Константы колонок
 * ============================================================ */
const FILE_COLS = ['Имя', 'Файл', 'Путь', '№', 'Дата', 'Жанр', 'Исполнитель', 'Альбом'];
const TC_NAME = 0, TC_PATH = 1;

/* ============================================================
 *  Окно
 * ============================================================ */
const win = new Gtk.Window({ title: 'Mp3-Explorer', default_width: winConfig.width, default_height: winConfig.height });
// Добавьте это ПОСЛЕ создания окна:
win.connect('configure-event', (w, event) => {
    const [width, height] = w.get_size();
    if (width > 1 && height > 1) {
        winConfig.width = width;
        winConfig.height = height;
    }
    return false;
});

// И измените destroy — размеры там больше не нужны:
win.connect('destroy', () => {
    // winConfig.width и winConfig.height уже сохранены в configure-event
    winConfig.hpaned = hpaned.get_position();
    winConfig.vpaned = vpaned.get_position();
    winConfig.collection = combo.get_active();
    winConfig.fileCols = getColumnConfig(fileListTree, fileListStore);
    winConfig.playlistCols = getColumnConfig(playlistContentTree, playlistContentStore);
    try { GLib.file_set_contents(WINDOW_FILE, JSON.stringify(winConfig, null, 2)); } catch (e) {}
    savePlaylists();
    Gtk.main_quit();
});

const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
win.add(vbox);

/* ============================================================
 *  Меню
 * ============================================================ */
const menubar = new Gtk.MenuBar();
vbox.pack_start(menubar, false, false, 0);

const fileMenu = new Gtk.Menu();
const miReload = new Gtk.MenuItem({ label: 'Reload' });
miReload.connect('activate', () => doReload());
fileMenu.append(miReload);
fileMenu.append(new Gtk.SeparatorMenuItem());
const miQuit = new Gtk.MenuItem({ label: 'Выход' });
miQuit.connect('activate', () => Gtk.main_quit());
fileMenu.append(miQuit);
const fileItem = new Gtk.MenuItem({ label: 'Файл' });
fileItem.set_submenu(fileMenu);
menubar.append(fileItem);

for (const label of ['Правка', 'Вид', '?']) {
    const item = new Gtk.MenuItem({ label });
    const sub  = new Gtk.Menu();
    sub.append(new Gtk.MenuItem({ label: '...' }));
    item.set_submenu(sub);
    menubar.append(item);
}

/* ============================================================
 *  Комбобокс + Reload
 * ============================================================ */
const comboRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
comboRow.set_margin_start(4); comboRow.set_margin_end(4);
comboRow.set_margin_top(4);   comboRow.set_margin_bottom(4);

const combo = new Gtk.ComboBoxText();
combo.set_hexpand(true);
for (const p of ROOTS) combo.append_text(p);

const reloadBtn = new Gtk.Button();
reloadBtn.add(new Gtk.Image({ icon_name: 'view-refresh', icon_size: Gtk.IconSize.BUTTON }));
reloadBtn.set_tooltip_text('Reload');
reloadBtn.connect('clicked', () => doReload());

comboRow.pack_start(combo, true, true, 0);
comboRow.pack_start(reloadBtn, false, false, 0);
vbox.pack_start(comboRow, false, false, 0);

/* ============================================================
 *  CSS (ручки 5px, диалоговый цвет, фон дерева)
 * ============================================================ */
const css = new Gtk.CssProvider();
const cssData = `
paned > separator {
    min-width: 5px;
    min-height: 5px;
    background-color: @theme_bg_color;
    border-left: 1px solid shade(@theme_bg_color, 0.9);
    border-right: 1px solid shade(@theme_bg_color, 0.9);
}
paned > separator:hover {
    background-color: shade(@theme_bg_color, 0.95);
}
#catalog-tree {
    background-color: #f5f5f5;
}
`;
try { css.load_from_data(cssData); } catch (e) {
    try { css.load_from_data(cssData, -1); } catch (e2) {}
}
Gtk.StyleContext.add_provider_for_screen(
    Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

/* ============================================================
 *  Горизонтальный Paned
 * ============================================================ */
const hpaned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
hpaned.set_hexpand(true); hpaned.set_vexpand(true);
hpaned.set_position(winConfig.hpaned);
vbox.pack_start(hpaned, true, true, 0);

/* ---------- Левая панель: фильтр + дерево ---------- */
const leftBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });

const filterRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
filterRow.set_margin_start(4); filterRow.set_margin_end(4);
filterRow.set_margin_top(4);   filterRow.set_margin_bottom(4);

const filterEntry = new Gtk.Entry({ hexpand: true, placeholder_text: 'Фильтр' });
const filesCheckbox = new Gtk.CheckButton({ label: 'Файлы' });
filterRow.pack_start(filterEntry, true, true, 0);
filterRow.pack_start(filesCheckbox, false, false, 0);
leftBox.pack_start(filterRow, false, false, 0);

// Глобальное состояние сканирования
let nodesByPath   = new Map();
let cachedFiles   = {};
let scanGeneration = 0;
let isScanning     = false;

const treeStore = Gtk.TreeStore.new([
    GObject.TYPE_STRING, // TC_NAME
    GObject.TYPE_STRING, // TC_PATH
]);


const filterState = { text: '', byFiles: false };

function matchesSelf(model, iter) {
    const text = filterState.text;
    if (!text) return true;
    const path = model.get_value(iter, TC_PATH);
    const node = nodesByPath.get(path);
    if (!node) return false;
    if (filterState.byFiles) return subtreeHasMatchingFile(node, text);
    return (node.name || '').toLowerCase().includes(text);
}

function subtreeHasMatchingFile(node, text) {
    for (const f of node.files) {
        if (f.name.toLowerCase().includes(text)) return true;
    }
    for (const c of node.children) {
        if (subtreeHasMatchingFile(c, text)) return true;
    }
    return false;
}

function hasMatchingDescendant(model, iter) {
    let child = unwrapIter(model.iter_children(iter));
    while (child) {
        if (matchesSelf(model, child)) return true;
        if (hasMatchingDescendant(model, child)) return true;
        child = unwrapNext(model, child);
    }
    return false;
}

function visibleFunc(model, iter) {
    if (!filterState.text) return true;
    return matchesSelf(model, iter) || hasMatchingDescendant(model, iter);
}

const treeFilter = treeStore.filter_new(null);
treeFilter.set_visible_func(visibleFunc);

const treeView = new Gtk.TreeView({ model: treeFilter });
treeView.set_headers_visible(false);
treeView.set_enable_tree_lines(true);
treeView.set_show_expanders(true);
treeView.set_name('catalog-tree');

const treeCol  = new Gtk.TreeViewColumn();
const treeRend = new Gtk.CellRendererText();
treeCol.pack_start(treeRend, true);
treeCol.add_attribute(treeRend, 'text', TC_NAME);
treeView.append_column(treeCol);

const treeScroll = new Gtk.ScrolledWindow();
treeScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
treeScroll.set_shadow_type(Gtk.ShadowType.IN);
treeScroll.add(treeView);
leftBox.pack_start(treeScroll, true, true, 0);
hpaned.pack1(leftBox, false, false);

/* ============================================================
 *  Правая панель
 * ============================================================ */
const vpaned = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });
vpaned.set_position(winConfig.vpaned);
hpaned.pack2(vpaned, true, false);

/* ---- Верхняя таблица файлов ---- */
const fileListStore = Gtk.ListStore.new(FILE_COLS.map(() => GObject.TYPE_STRING));
const fileListTree  = new Gtk.TreeView({ model: fileListStore });
// 1. Колонки для fileListTree — сразу после его объявления
FILE_COLS.forEach((title, idx) => {
    const col = new Gtk.TreeViewColumn({ title, sort_column_id: idx });
    const rend = new Gtk.CellRendererText();
    col.pack_start(rend, true);
    col.add_attribute(rend, 'text', idx);
    col.set_resizable(true);
    col.set_min_width(50);
    col.set_reorderable(true);
    fileListTree.append_column(col);
});
fileListTree.set_hexpand(true);
fileListTree.set_vexpand(true);
fileListTree.set_grid_lines(Gtk.TreeViewGridLines.HORIZONTAL);
fileListTree.set_enable_search(false);
fileListTree.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE);

fileListTree.set_reorderable(true);

const fileListScroll = new Gtk.ScrolledWindow();
fileListScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
fileListScroll.set_shadow_type(Gtk.ShadowType.IN);
fileListScroll.add(fileListTree);
vpaned.pack1(fileListScroll, true, true);

// Уже вызван fileListTree.set_reorderable(true) выше — он настроил внутренний
// source/dest на GTK_TREE_MODEL_ROW. Добавляем text/plain, НЕ затирая его.
fileListTree.drag_source_add_text_targets();

let fileListSavedPaths = [];

fileListTree.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 1) return false;
    const [ex, ey] = evtXY(event);
    const path = getHitPath(w, ex, ey);
    if (!path) { fileListSavedPaths = []; return false; }
    const paths = getSelectedRows(w);
    let found = false;
    for (const p of paths) {
        if (p.toString() === path.toString()) { found = true; break; }
    }
    fileListSavedPaths = (found && paths.length > 1) ? paths : [];
    return false;
});

fileListTree.connect('drag-data-get', (w, ctx, sel, info, time) => {
    let tracks = [];
    if (fileListSavedPaths.length > 0) {
        for (const p of fileListSavedPaths) {
            const iter = unwrapIter(fileListStore.get_iter(p));
            if (iter) {
                const name = fileListStore.get_value(iter, 0);
                const file = fileListStore.get_value(iter, 1);
                const dir  = fileListStore.get_value(iter, 2);
                const fullPath = dir.endsWith('/') ? dir + file : dir + '/' + file;
                tracks.push({ name, path: fullPath });
            }
        }
        fileListSavedPaths = [];
    } else {
        tracks = getSelectedTracks(w, fileListStore);
    }
    if (tracks.length > 0) {
        sel.set_text(JSON.stringify(tracks), -1);
    }
});

/* ---- Нижняя панель: плейлисты ---- */
const bottomPaned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
bottomPaned.set_position(200);
vpaned.pack2(bottomPaned, false, false);

const playlistsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });

const playlistStore = Gtk.TreeStore.new([GObject.TYPE_STRING]);
const playlistTree  = new Gtk.TreeView({ model: playlistStore });
playlistTree.set_headers_visible(false);

const plCol  = new Gtk.TreeViewColumn();
const plRend = new Gtk.CellRendererText();
plCol.pack_start(plRend, true);
plCol.add_attribute(plRend, 'text', 0);
playlistTree.append_column(plCol);

const playlistScroll = new Gtk.ScrolledWindow();
playlistScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
playlistScroll.set_shadow_type(Gtk.ShadowType.IN);
playlistScroll.add(playlistTree);
playlistsBox.pack_start(playlistScroll, true, true, 0);

const plBtnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 });
plBtnBox.set_margin_start(2); plBtnBox.set_margin_end(2);
plBtnBox.set_margin_top(2);   plBtnBox.set_margin_bottom(2);
const btnAdd  = new Gtk.Button({ label: '+', tooltip_text: 'Добавить' });
const btnDel  = new Gtk.Button({ label: '−', tooltip_text: 'Удалить' });
const btnUp   = new Gtk.Button({ label: '▲', tooltip_text: 'Вверх' });
const btnDown = new Gtk.Button({ label: '▼', tooltip_text: 'Вниз' });
for (const b of [btnAdd, btnDel, btnUp, btnDown])
    plBtnBox.pack_start(b, true, true, 0);
playlistsBox.pack_start(plBtnBox, false, false, 0);
bottomPaned.pack1(playlistsBox, false, false);

const playlistContentStore = Gtk.ListStore.new(FILE_COLS.map(() => GObject.TYPE_STRING));
const playlistContentTree  = new Gtk.TreeView({ model: playlistContentStore });
playlistContentTree.set_hexpand(true);
playlistContentTree.set_vexpand(true);
playlistContentTree.set_grid_lines(Gtk.TreeViewGridLines.HORIZONTAL);
playlistContentTree.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE);

function trackNumberCompare(model, iter1, iter2, user_data) {
    // В GJS 4-й аргумент — это user_data, а не columnId.
    // Поэтому мы жестко задаем индекс колонки "№" (3).
    const col = 3; 
    const val1 = model.get_value(iter1, col) || '';
    const val2 = model.get_value(iter2, col) || '';
    const num1 = parseInt(val1, 10);
    const num2 = parseInt(val2, 10);
    
    if (!isNaN(num1) && !isNaN(num2)) return num1 - num2;
    if (val1 < val2) return -1;
    if (val1 > val2) return 1;
    return 0;
}

const TRACK_NUM_COLUMN_ID = 3;

fileListStore.set_sort_func(TRACK_NUM_COLUMN_ID, trackNumberCompare);
playlistContentStore.set_sort_func(TRACK_NUM_COLUMN_ID, trackNumberCompare);

// Колонки плейлиста — ПОСЛЕ объявления playlistContentTree
FILE_COLS.forEach((title, idx) => {
    const col = new Gtk.TreeViewColumn({ title, sort_column_id: idx });
    const rend = new Gtk.CellRendererText();
    col.pack_start(rend, true);
    col.add_attribute(rend, 'text', idx);
    col.set_resizable(true);
    col.set_min_width(50);
    col.set_reorderable(true);   // ← перетаскивание ЗАГОЛОВКА
    playlistContentTree.append_column(col);
});

// Перетаскивание строк внутри плейлиста (не путать с колонками!)
playlistContentTree.set_reorderable(true);
playlistContentTree.drag_dest_add_text_targets();

const playlistContentScroll = new Gtk.ScrolledWindow();
playlistContentScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
playlistContentScroll.set_shadow_type(Gtk.ShadowType.IN);
playlistContentScroll.add(playlistContentTree);
bottomPaned.pack2(playlistContentScroll, true, false);

/* ============================================================
 *  Применение сохранённых настроек колонок
 * ============================================================ */
function getColumnConfig(treeView, model) {
    const cols = treeView.get_columns();
    const order = cols.map(c => c.get_title());
    const widths = {};
    cols.forEach(c => widths[c.get_title()] = c.get_width());
    let sortId = -1, sortOrder = 0;
    if (model) {
        const s = model.get_sort_column_id();
        if (s) {
            if (Array.isArray(s)) {
                if (typeof s[0] === 'boolean') {
                    if (s[0]) { sortId = s[1]; sortOrder = s[2]; }
                } else {
                    sortId = s[0]; sortOrder = s[1];
                }
            }
        }
    }
    return { order, widths, sortId, sortOrder };
}

function applyColumnConfig(treeView, model, config) {
    if (!config) return;
    const cols = treeView.get_columns();
    const colMap = {};
    cols.forEach(c => colMap[c.get_title()] = c);

    const order = config.order || [];
    order.forEach(title => {
        const c = colMap[title];
        if (c) {
            treeView.remove_column(c);
            treeView.append_column(c);
        }
    });
    cols.forEach(c => {
        const title = c.get_title();
        if (!order.includes(title)) {
            treeView.remove_column(c);
            treeView.append_column(c);
        }
    });

    const widths = config.widths || {};
    for (const title in widths) {
        if (colMap[title]) colMap[title].set_fixed_width(widths[title]);
    }

    if (config.sortId !== undefined && config.sortId >= 0) {
        model.set_sort_column_id(config.sortId, config.sortOrder);
    }
}

applyColumnConfig(fileListTree, fileListStore, winConfig.fileCols);
applyColumnConfig(playlistContentTree, playlistContentStore, winConfig.playlistCols);

/* ============================================================
 *  Статусбар + прогресс
 * ============================================================ */
const statusbar = new Gtk.Statusbar();
const progress  = new Gtk.ProgressBar({ width_request: 200, show_text: false });
progress.set_no_show_all(true);
statusbar.pack_end(progress, false, false, 4);
vbox.pack_start(statusbar, false, false, 0);
statusbar.push(1, 'Готово');

/* ============================================================
 *  Данные плейлистов + JSON
 * ============================================================ */
const PLAYLIST_DATA = new Map();
let syncingPlaylist = false;
let syncTimer = 0;

function loadPlaylists() {
    PLAYLIST_DATA.clear();
    try {
        const [ok, data] = GLib.file_get_contents(PLAYLISTS_FILE);
        if (ok) {
            const obj = JSON.parse(ByteArray.toString(data));
            for (const [name, tracks] of Object.entries(obj)) {
                PLAYLIST_DATA.set(name, tracks);
            }
        }
    } catch (e) {}
    
    playlistStore.clear();
    for (const [name] of PLAYLIST_DATA) {
        const iter = playlistStore.append(null);
        playlistStore.set(iter, [0], [name]);
    }
}

function savePlaylists() {
    const obj = {};
    let iter = unwrapIter(playlistStore.get_iter_first());
    while (iter) {
        const name = playlistStore.get_value(iter, 0);
        obj[name] = (PLAYLIST_DATA.get(name) || []).map(f => ({ name: f.name, path: f.path }));
        iter = unwrapNext(playlistStore, iter);
    }
    try {
        GLib.file_set_contents(PLAYLISTS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {}
}

function syncPlaylistData() {
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (!piter) return;
    const plName = pmodel.get_value(piter, 0);
    const files = [];
    let iter = unwrapIter(playlistContentStore.get_iter_first());
    while (iter) {
        const name = playlistContentStore.get_value(iter, 0);
        const file = playlistContentStore.get_value(iter, 1);
        const dir = playlistContentStore.get_value(iter, 2);
        const fullPath = dir.endsWith('/') ? dir + file : dir + '/' + file;
        files.push({ name, path: fullPath });
        iter = unwrapNext(playlistContentStore, iter);
    }
    PLAYLIST_DATA.set(plName, files);
    savePlaylists();
}

function scheduleSync() {
    if (syncingPlaylist) return;
    if (syncTimer) { GLib.source_remove(syncTimer); syncTimer = 0; }
    syncTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        syncTimer = 0;
        syncPlaylistData();
        return GLib.SOURCE_REMOVE;
    });
}

function showPlaylistContent(name) {
    syncingPlaylist = true;
    try {
        playlistContentStore.clear();
        const files = PLAYLIST_DATA.get(name) || [];
        let n = 1;
        for (const f of files) {
            const it = playlistContentStore.append();
            playlistContentStore.set(it, [0,1,2,3,4,5,6,7],
                                     [f.name, GLib.path_get_basename(f.path), GLib.path_get_dirname(f.path) + '/', String(n++), '', '', '', '']);
        }
    } finally {
        syncingPlaylist = false;
    }
}

playlistContentStore.connect('row-inserted', scheduleSync);
playlistContentStore.connect('row-deleted',  scheduleSync);
playlistContentStore.connect('row-changed',  scheduleSync);
playlistContentStore.connect('rows-reordered', scheduleSync);

function addToPlaylist(plName, trackObj) {
    const files = PLAYLIST_DATA.get(plName) || [];
    files.push({ name: trackObj.name || GLib.path_get_basename(trackObj.path), path: trackObj.path });
    PLAYLIST_DATA.set(plName, files);
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (piter && pmodel.get_value(piter, 0) === plName) {
        showPlaylistContent(plName);
    }
    savePlaylists();
}

function buildAddToPlaylistSubmenu(trackObjs) {
    const sub = new Gtk.Menu();
    if (PLAYLIST_DATA.size === 0) {
        const empty = new Gtk.MenuItem({ label: '(нет плейлистов)' });
        empty.set_sensitive(false);
        sub.append(empty);
    } else {
        for (const [plName] of PLAYLIST_DATA) {
            const item = new Gtk.MenuItem({ label: plName });
            item.connect('activate', () => {
                for (const t of trackObjs) addToPlaylist(plName, t);
            });
            sub.append(item);
        }
    }
    sub.show_all();
    return sub;
}

/* ============================================================
 *  Управление плеером
 * ============================================================ */
function playFile(filePath) {
    const cmdTemplate = getPlayCommand();
    if (!cmdTemplate) {
        console.log(`[player] команда не задана, файл: ${filePath}`);
        return;
    }
    const cmd = cmdTemplate.replace(/%f/g, `"${filePath}"`);
    try { GLib.spawn_command_line_async(cmd); } catch (e) {}
}

function enqueueFile(filePath) {
    const cmdTemplate = getEnqueueCommand();
    if (!cmdTemplate) {
        console.log(`[player] команда не задана, файл: ${filePath}`);
        return;
    }
    const cmd = cmdTemplate.replace(/%f/g, `"${filePath}"`);
    try { GLib.spawn_command_line_async(cmd); } catch (e) {}
}

function playFilesAsM3U(tracks, isEnqueue) {
    if (tracks.length === 0) return;
    const tmpPath = GLib.build_filenamev([GLib.get_tmp_dir(), `mp3-explorer-${Date.now()}.m3u`]);
    let content = '#EXTM3U\n';
    for (const t of tracks) content += t.path + '\n';
    GLib.file_set_contents(tmpPath, content);
    if (isEnqueue) enqueueFile(tmpPath);
    else playFile(tmpPath);
}

function playTracks(tracks, isEnqueue) {
    if (tracks.length === 0) return;
    if (tracks.length === 1) {
        if (isEnqueue) enqueueFile(tracks[0].path); else playFile(tracks[0].path);
        return;
    }
    const useM3U = getMultipleM3U();
    if (useM3U) {
        playFilesAsM3U(tracks, isEnqueue);
    } else {
        const cmdTemplate = isEnqueue ? getEnqueueCommand() : getPlayCommand();
        if (!cmdTemplate) return;
        const paths = tracks.map(t => `"${t.path}"`).join(' ');
        const cmd = cmdTemplate.replace(/%f/g, paths);
        try { GLib.spawn_command_line_async(cmd); } catch (e) {}
    }
}

/* ============================================================
 *  Сканирование и кэширование (двухфазное, инкрементальное)
 * ============================================================ */
function getCacheFilePath(rootPath) {
    const md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, rootPath, -1);
    return GLib.build_filenamev([CACHE_DIR, md5 + '.json']);
}

function loadCacheForRoot(rootPath) {
    const cacheFile = getCacheFilePath(rootPath);
    if (!GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) return {};
    try {
        const [ok, data] = GLib.file_get_contents(cacheFile);
        if (ok) return JSON.parse(ByteArray.toString(data));
    } catch (e) {}
    return {};
}

function saveCacheFromNodes(rootPath) {
    const out = {};
    for (const [, node] of nodesByPath) {
        for (const f of node.files) {
            if (f.tags) out[f.path] = { size: f.size, tags: f.tags };
        }
    }
    const cacheFile = getCacheFilePath(rootPath);
    try { GLib.file_set_contents(cacheFile, JSON.stringify(out)); } catch (e) {}
}

function readID3v1(path) {
    let stream = null;
    try {
        const file = Gio.File.new_for_path(path);
        const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        if (size < 128) return {};
        stream = file.read(null);
        stream.seek(size - 128, 0, null);
        const buffer = new Uint8Array(128);
        let bytesRead = stream.read(buffer, null);
        if (Array.isArray(bytesRead)) bytesRead = bytesRead[0];
        if (bytesRead < 128) return {};
        if (buffer[0] !== 0x54 || buffer[1] !== 0x41 || buffer[2] !== 0x47) return {};
        const dec = (arr) => String.fromCharCode.apply(null, arr).replace(/\0/g, '').trim();
        return {
            title:  dec(buffer.slice(3, 33)),
            artist: dec(buffer.slice(33, 63)),
            album:  dec(buffer.slice(63, 93)),
            date:   dec(buffer.slice(93, 97)),
        };
    } catch (e) {
        return {};
    } finally {
        if (stream) try { stream.close(null); } catch (e2) {}
    }
}

/* ---------- Фаза 1: обход каталогов ---------- */
function startScan(rootPath) {
    scanGeneration++;
    const gen = scanGeneration;
    isScanning = true;
    nodesByPath = new Map();
    treeStore.clear();
    fileListStore.clear();

    const rootNode = { name: GLib.path_get_basename(rootPath), path: rootPath, files: [], children: [] };
    nodesByPath.set(rootPath, rootNode);
    cachedFiles = loadCacheForRoot(rootPath);

    const queue = [rootPath];
    let processedDirs = 0;

    progress.set_no_show_all(false);
    progress.show();
    progress.pulse();
    statusbar.push(1, `Сканирование каталогов: ${rootPath}`);

    const phase1 = () => {
        if (gen !== scanGeneration) return GLib.SOURCE_REMOVE;
        if (queue.length === 0) {
            pruneEmpty(rootNode);
            buildTreeUI(rootNode, null);
            treeView.expand_row(Gtk.TreePath.new_from_indices([0]), false);
            treeView.get_selection().unselect_all();
            statusbar.push(1, `Каталоги: ${processedDirs} шт. Читаем ID3…`);
            startPhase2(gen);
            return GLib.SOURCE_REMOVE;
        }
        const dirPath = queue.shift();
        scanOneDir(dirPath, queue);
        processedDirs++;
        if (processedDirs % 50 === 0) {
            progress.pulse();
            statusbar.push(1, `Сканирование каталогов: ${processedDirs} шт., в очереди ${queue.length}`);
        }
        return GLib.SOURCE_CONTINUE;
    };
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, phase1);
}

function scanOneDir(dirPath, queue) {
    let enumerator = null;
    try {
        const node = nodesByPath.get(dirPath);
        if (!node) return;
        const file = Gio.File.new_for_path(dirPath);
        enumerator = file.enumerate_children(
            'standard::name,standard::type,standard::size',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const type = info.get_file_type();
            const fullPath = GLib.build_filenamev([dirPath, name]);
            if (type === Gio.FileType.DIRECTORY) {
                const childNode = { name, path: fullPath, files: [], children: [] };
                node.children.push(childNode);
                nodesByPath.set(fullPath, childNode);
                queue.push(fullPath);
            } else if (name.toLowerCase().endsWith('.mp3')) {
                const size = info.get_size();
                let tags = null;
                const cached = cachedFiles[fullPath];
                if (cached && cached.size === size && cached.tags) {
                    tags = cached.tags;
                }
                node.files.push({ name, path: fullPath, size, tags });
            }
        }
    } catch (e) {
    } finally {
        if (enumerator) try { enumerator.close(null); } catch (e2) {}
    }
}

function pruneEmpty(node) {
    const kept = [];
    for (const child of node.children) {
        pruneEmpty(child);
        if (child.files.length > 0 || child.children.length > 0) kept.push(child);
    }
    node.children = kept;
}

function buildTreeUI(node, parentIter) {
    const iter = treeStore.append(parentIter);
    treeStore.set(iter, [TC_NAME, TC_PATH], [node.name, node.path]);
    for (const child of node.children) buildTreeUI(child, iter);
    return iter;
}

/* ---------- Фаза 2: чтение ID3 ---------- */
function startPhase2(gen) {
    const filesToRead = [];
    for (const [, node] of nodesByPath) {
        for (const f of node.files) if (!f.tags) filesToRead.push(f);
    }
    if (filesToRead.length === 0) { finishPhase2(gen); return; }

    const total = filesToRead.length;
    let idx = 0;
    progress.set_fraction(0);
    statusbar.push(1, `Чтение ID3: 0/${total}`);

    const phase2 = () => {
        if (gen !== scanGeneration) return GLib.SOURCE_REMOVE;
        if (idx >= total) { finishPhase2(gen); return GLib.SOURCE_REMOVE; }
        for (let i = 0; i < 10 && idx < total; i++, idx++) {
            filesToRead[idx].tags = readID3v1(filesToRead[idx].path);
        }
        progress.set_fraction(idx / total);
        statusbar.push(1, `Чтение ID3: ${idx}/${total}`);
        if (idx % 50 < 10) refreshFileListIfVisible();
        return GLib.SOURCE_CONTINUE;
    };
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, phase2);
}

function finishPhase2(gen) {
    if (gen !== scanGeneration) return;
    isScanning = false;
    progress.hide();
    progress.set_no_show_all(true);
    const idx = combo.get_active();
    if (idx >= 0) saveCacheFromNodes(ROOTS[idx]);
    statusbar.push(1, 'Готово');
    refreshFileListIfVisible();
}

/* ---------- Заполнение таблицы из узла ---------- */
function populateFileListFromNode(node) {
    fileListStore.clear();
    if (!node) return;
    let n = 1;
    for (const f of node.files) {
        const t = f.tags || {};
        const it = fileListStore.append();
        fileListStore.set(it, [0,1,2,3,4,5,6,7],
            [t.title || f.name.replace(/\.mp3$/i, ''),
             GLib.path_get_basename(f.path),
             GLib.path_get_dirname(f.path) + '/',
             String(n++),
             t.date || '', t.genre || '', t.artist || '', t.album || '']);
    }
    statusbar.push(1, `${node.files.length} файлов в ${node.path}`);
}

function refreshFileListIfVisible() {
    const [model, iter] = getSelected(treeView.get_selection());
    if (!iter) return;
    const path = model.get_value(iter, TC_PATH);
    populateFileListFromNode(nodesByPath.get(path));
}

function collectAllFiles(node) {
    const out = [];
    for (const f of node.files) {
        const t = f.tags || {};
        out.push({ name: t.title || f.name.replace(/\.mp3$/i, ''), path: f.path });
    }
    for (const c of node.children) out.push(...collectAllFiles(c));
    return out;
}

/* ---------- Reload (только новые/изменённые) ---------- */
function doReload() {
    const idx = combo.get_active();
    if (idx < 0) return;
    const cacheFile = getCacheFilePath(ROOTS[idx]);
    if (GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
        try { GLib.unlink(cacheFile); } catch (e) {}
    }
    startScan(ROOTS[idx]);
}

/* ============================================================
 *  Обработчики интерфейса
 * ============================================================ */
treeView.get_selection().connect('changed', () => {
    refreshFileListIfVisible();
});

fileListTree.connect('key-press-event', (w, event) => {
    const kv = evtKeyval(event);
    if (kv === Gdk.KEY_Return || kv === Gdk.KEY_KP_Enter) {
        const tracks = getSelectedTracks(w, fileListStore);
        if (tracks.length > 1) {
            playTracks(tracks, false);
            return true;   // не даём сработать row-activated (он сыграл бы одну)
        }
    }
    return false;
});

fileListTree.connect('row-activated', (w, path) => {
    const iter = unwrapIter(fileListStore.get_iter(path));
    if (!iter) return;
    const file = fileListStore.get_value(iter, 1);
    const dir = fileListStore.get_value(iter, 2);
    const fullPath = dir.endsWith('/') ? dir + file : dir + '/' + file;
    playTracks([{ path: fullPath }], false);
});

playlistContentTree.connect('key-press-event', (w, event) => {
    const kv = evtKeyval(event);
    if (kv === Gdk.KEY_Return || kv === Gdk.KEY_KP_Enter) {
        const tracks = getSelectedTracks(w, playlistContentStore);
        if (tracks.length > 1) {
            playTracks(tracks, false);
            return true;
        }
    }
    return false;
});

playlistContentTree.connect('row-activated', (w, path) => {
    const iter = unwrapIter(playlistContentStore.get_iter(path));
    if (!iter) return;
    const file = playlistContentStore.get_value(iter, 1);
    const dir = playlistContentStore.get_value(iter, 2);
    const fullPath = dir.endsWith('/') ? dir + file : dir + '/' + file;
    playTracks([{ path: fullPath }], false);
});

playlistTree.get_selection().connect('changed', () => {
    const [model, iter] = getSelected(playlistTree.get_selection());
    if (!iter) {
        syncingPlaylist = true;
        try { playlistContentStore.clear(); } finally { syncingPlaylist = false; }
        return;
    }
    showPlaylistContent(model.get_value(iter, 0));
});

/* ============================================================
 *  Диалоги и кнопки плейлистов
 * ============================================================ */
function doRenamePlaylist(model, iter) {
    const oldName = model.get_value(iter, 0);
    const dialog = new Gtk.Dialog({ title: 'Переименовать плейлист', transient_for: win, modal: true });
    dialog.add_button('Отмена', Gtk.ResponseType.CANCEL);
    dialog.add_button('ОК',     Gtk.ResponseType.OK);
    dialog.set_default_response(Gtk.ResponseType.OK);

    const entry = new Gtk.Entry({ text: oldName });
    entry.set_activates_default(true);
    dialog.get_content_area().add(entry);
    dialog.show_all();

    dialog.connect('response', (d, resp) => {
        if (resp === Gtk.ResponseType.OK) {
            const newName = entry.get_text().trim();
            if (newName && newName !== oldName && !PLAYLIST_DATA.has(newName)) {
                const files = PLAYLIST_DATA.get(oldName) || [];
                PLAYLIST_DATA.delete(oldName);
                PLAYLIST_DATA.set(newName, files);
                model.set_value(iter, 0, newName);
                savePlaylists();
            }
        }
        d.destroy();
    });
}

function doDeletePlaylist() {
    const [model, iter] = getSelected(playlistTree.get_selection());
    if (!iter) return;
    const name = model.get_value(iter, 0);
    PLAYLIST_DATA.delete(name);
    playlistStore.remove(iter);
    savePlaylists();
}

function doAddPlaylist() {
    const base = 'Новый плейлист';
    let unique = base, i = 1;
    while (PLAYLIST_DATA.has(unique)) unique = `${base} ${++i}`;
    PLAYLIST_DATA.set(unique, []);
    const iter = playlistStore.append(null);
    playlistStore.set(iter, [0], [unique]);
    playlistTree.get_selection().select_iter(iter);
    savePlaylists();
}

function movePlaylist(delta) {
    const [model, iter] = getSelected(playlistTree.get_selection());
    if (!iter) return;
    const idx    = model.get_path(iter).get_indices()[0];
    const newIdx = idx + delta;
    const count  = model.iter_n_children(null);
    if (newIdx < 0 || newIdx >= count) return;
    const other = unwrapIter(model.iter_nth_child(null, newIdx));
    if (!other) return;

    const nameA = model.get_value(iter, 0);
    const nameB = model.get_value(other, 0);

    model.set_value(iter, 0, nameB);
    model.set_value(other, 0, nameA);

    const newIter = unwrapIter(model.iter_nth_child(null, newIdx));
    if (newIter) playlistTree.get_selection().select_iter(newIter);
    savePlaylists();
}

playlistTree.connect('row-activated', (w, path) => {
    const [model, iter] = getSelected(w.get_selection());
    if (iter) doRenamePlaylist(model, iter);
});

btnAdd.connect('clicked',  () => doAddPlaylist());
btnDel.connect('clicked',  () => doDeletePlaylist());
btnUp.connect('clicked',   () => movePlaylist(-1));
btnDown.connect('clicked', () => movePlaylist(1));

/* ============================================================
 *  Контекстные меню
 * ============================================================ */
treeView.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event);
    const path = getHitPath(w, ex, ey);
    if (!path) return false;
    w.get_selection().select_path(path);
    const [model, iter] = getSelected(w.get_selection());
    if (!iter) return false;

    const dirPath = model.get_value(iter, TC_PATH);
    const node = nodesByPath.get(dirPath);
    const files = node ? collectAllFiles(node) : [];

    const menu = new Gtk.Menu();
    const miPlay = new Gtk.MenuItem({ label: `Проиграть всё (${files.length})` });
    miPlay.set_sensitive(files.length > 0);
    miPlay.connect('activate', () => playTracks(files, false));
    menu.append(miPlay);

    const miEnq = new Gtk.MenuItem({ label: `Добавить всё в очередь (${files.length})` });
    miEnq.set_sensitive(files.length > 0);
    miEnq.connect('activate', () => playTracks(files, true));
    menu.append(miEnq);

    menu.append(new Gtk.SeparatorMenuItem());

    const miAdd = new Gtk.MenuItem({ label: 'Добавить всё в плейлист' });
    miAdd.set_sensitive(files.length > 0);
    miAdd.set_submenu(buildAddToPlaylistSubmenu(files));
    menu.append(miAdd);

    menu.append(new Gtk.SeparatorMenuItem());

    const miRl = new Gtk.MenuItem({ label: 'Обновить' });
    miRl.connect('activate', () => doReload());
    menu.append(miRl);

    popupMenuAtPointer(menu);
    return true;
});

fileListTree.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event);
    const path = getHitPath(w, ex, ey);
    if (!path) return false;
    
    const selection = w.get_selection();
    const paths = getSelectedRows(w);
    let found = false;
    for (const p of paths) {
        if (p.toString() === path.toString()) { found = true; break; }
    }
    if (!found) {
        selection.unselect_all();
        selection.select_path(path);
    }

    const tracks = getSelectedTracks(w, fileListStore);
    if (tracks.length === 0) return false;

    const menu = new Gtk.Menu();
    const miPlay = new Gtk.MenuItem({ label: tracks.length > 1 ? `Проиграть выделенные (${tracks.length})` : 'Проиграть' });
    miPlay.connect('activate', () => playTracks(tracks, false));
    menu.append(miPlay);

    const miEnq = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить в очередь выделенные (${tracks.length})` : 'Добавить в очередь' });
    miEnq.connect('activate', () => playTracks(tracks, true));
    menu.append(miEnq);

    menu.append(new Gtk.SeparatorMenuItem());

    const miAdd = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить выделенные в плейлист (${tracks.length})` : 'Добавить в плейлист' });
    miAdd.set_submenu(buildAddToPlaylistSubmenu(tracks));
    menu.append(miAdd);

    popupMenuAtPointer(menu);
    return true;
});

playlistContentTree.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event);
    const path = getHitPath(w, ex, ey);
    if (!path) return false;

    const selection = w.get_selection();
    const paths = getSelectedRows(w);
    let found = false;
    for (const p of paths) {
        if (p.toString() === path.toString()) { found = true; break; }
    }
    if (!found) {
        selection.unselect_all();
        selection.select_path(path);
    }

    const tracks = getSelectedTracks(w, playlistContentStore);
    if (tracks.length === 0) return false;

    const menu = new Gtk.Menu();
    const miPlay = new Gtk.MenuItem({ label: tracks.length > 1 ? `Проиграть выделенные (${tracks.length})` : 'Проиграть' });
    miPlay.connect('activate', () => playTracks(tracks, false));
    menu.append(miPlay);

    const miEnq = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить в очередь выделенные (${tracks.length})` : 'Добавить в очередь' });
    miEnq.connect('activate', () => playTracks(tracks, true));
    menu.append(miEnq);

    menu.append(new Gtk.SeparatorMenuItem());

    const miAdd = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить выделенные в плейлист (${tracks.length})` : 'Добавить в плейлист' });
    miAdd.set_submenu(buildAddToPlaylistSubmenu(tracks));
    menu.append(miAdd);

    menu.append(new Gtk.SeparatorMenuItem());

    const miDel = new Gtk.MenuItem({ label: tracks.length > 1 ? `Удалить выделенные (${tracks.length})` : 'Удалить из плейлиста' });
    miDel.connect('activate', () => {
        const [pmodel, piter] = getSelected(playlistTree.get_selection());
        if (piter) {
            const plName = pmodel.get_value(piter, 0);
            let files = PLAYLIST_DATA.get(plName) || [];
            for (const t of tracks) {
                const pos = files.findIndex(f => f.path === t.path);
                if (pos >= 0) files.splice(pos, 1);
            }
            PLAYLIST_DATA.set(plName, files);
            showPlaylistContent(plName);
            savePlaylists();
        }
    });
    menu.append(miDel);

    popupMenuAtPointer(menu);
    return true;
});

playlistTree.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event);
    const path = getHitPath(w, ex, ey);
    if (!path) return false;
    w.get_selection().select_path(path);
    const [model, iter] = getSelected(w.get_selection());
    if (!iter) return false;

    const plName = model.get_value(iter, 0);
    const files  = PLAYLIST_DATA.get(plName) || [];
    const idx    = model.get_path(iter).get_indices()[0];
    const count  = model.iter_n_children(null);

    const menu = new Gtk.Menu();
    const miPlay = new Gtk.MenuItem({ label: `Проиграть (${files.length})` });
    miPlay.set_sensitive(files.length > 0);
    miPlay.connect('activate', () => playTracks(files, false));
    menu.append(miPlay);

    const miEnq = new Gtk.MenuItem({ label: `Добавить в очередь (${files.length})` });
    miEnq.set_sensitive(files.length > 0);
    miEnq.connect('activate', () => playTracks(files, true));
    menu.append(miEnq);

    menu.append(new Gtk.SeparatorMenuItem());

    const miRen = new Gtk.MenuItem({ label: 'Переименовать' });
    miRen.connect('activate', () => doRenamePlaylist(model, iter));
    menu.append(miRen);

    const miDel = new Gtk.MenuItem({ label: 'Удалить' });
    miDel.connect('activate', () => doDeletePlaylist());
    menu.append(miDel);

    menu.append(new Gtk.SeparatorMenuItem());

    const miUp = new Gtk.MenuItem({ label: 'Поднять выше' });
    miUp.set_sensitive(idx > 0);
    miUp.connect('activate', () => movePlaylist(-1));
    menu.append(miUp);

    const miDown = new Gtk.MenuItem({ label: 'Опустить ниже' });
    miDown.set_sensitive(idx < count - 1);
    miDown.connect('activate', () => movePlaylist(1));
    menu.append(miDown);

    popupMenuAtPointer(menu);
    return true;
});

/* ============================================================
 *  DnD в плейлист
 * ============================================================ */
playlistContentTree.connect('drag-data-received', (w, ctx, x, y, sel, info, time) => {
    if (Gtk.drag_get_source_widget(ctx) === w) return;

    const text = sel.get_text();
    if (!text) {
        Gtk.drag_finish(ctx, false, false, time);
        return;
    }
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (!piter) {
        Gtk.drag_finish(ctx, false, false, time);
        return;
    }
    const plName = pmodel.get_value(piter, 0);
    try {
        const parsed = JSON.parse(text);
        const tracks = Array.isArray(parsed) ? parsed : [parsed];
        for (const t of tracks) {
            if (t.path) addToPlaylist(plName, t);
        }
    } catch (e) {
        addToPlaylist(plName, { name: GLib.path_get_basename(text), path: text });
    }
    Gtk.drag_finish(ctx, true, false, time);
});

/* ============================================================
 *  Фильтр
 * ============================================================ */
let filterDebounce = null;

function scheduleFilter() {
    if (filterDebounce) { GLib.source_remove(filterDebounce); filterDebounce = null; }
    filterDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        filterDebounce = null;
        applyFilter();
        return GLib.SOURCE_REMOVE;
    });
}

function applyFilter() {
    filterState.text    = filterEntry.get_text().toLowerCase().trim();
    filterState.byFiles = filesCheckbox.get_active();
    treeFilter.refilter();
    if (filterState.text) treeView.expand_all();
    else {
        treeView.collapse_all();
        treeView.expand_row(Gtk.TreePath.new_from_indices([0]), false);
    }
}

filterEntry.connect('changed', scheduleFilter);
filesCheckbox.connect('toggled', scheduleFilter);

/* ============================================================
 *  Старт
 * ============================================================ */

combo.connect('changed', () => {
    const idx = combo.get_active();
    if (idx >= 0) startScan(ROOTS[idx]);
});

loadPlaylists();

if (ROOTS.length > 0) {
    // Если передан аргумент командной строки, приоритет у него
    let targetIndex = winConfig.collection;
    if (cliRoot) {
        const absPath = GLib.canonicalize_filename(cliRoot, GLib.get_current_dir());
        const idx = ROOTS.indexOf(absPath);
        if (idx >= 0) targetIndex = idx;
    }

    if (targetIndex >= 0 && targetIndex < ROOTS.length) {
        combo.set_active(targetIndex);
    } else {
        combo.set_active(0);
    }
}

// Принудительно вызываем загрузку дерева после отображения окна,
// чтобы ComboBox гарантированно применил выбор
win.show_all();
Gtk.main();
