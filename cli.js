#!/usr/bin/env node
'use strict';

/**
 * @file Консольная часть QuickRun: сборка C++ и запуск программы.
 *
 * Это обычный Node.js-скрипт, он не зависит от VS Code. Его запускает команда `run`
 * (см. extension.js). Порядок работы:
 *   1. Определить, что собирать (файл из аргумента, main.cpp или единственный .cpp с main).
 *   2. Выбрать режим: CMake (если есть CMakeLists.txt) или прямой вызов компилятора.
 *   3. Пропустить сборку, если исходники не менялись.
 *   4. Собрать, показать ошибки и предупреждения, при успехе — запустить.
 *
 * Использование: run [файл.cpp | папка] [-r] [-- аргументы программы]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE_SUFFIX = IS_WIN ? '.exe' : '';

/** Папки, которые не просматриваем при поиске исходников. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.quickrun', 'build', 'out', '.vscode']);

/** Расширения исходников и заголовков. */
const SOURCE_EXT = new Set(['.cpp', '.cc', '.cxx']);
const HEADER_EXT = new Set(['.h', '.hpp', '.hh']);

/** ANSI-цвета для вывода. */
const color = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * Печатает сообщение об ошибке и завершает программу.
 * @param {string} msg Текст ошибки.
 * @returns {never}
 */
function fail(msg) {
  console.error(color.red('✖ ' + msg));
  process.exit(1);
}

/**
 * Читает настройки, которые плагин передал через переменные окружения.
 * @returns {{compiler: string, flags: string[]}}
 */
function readConfig() {
  let flags = ['-std=c++17', '-Wall'];
  try {
    const parsed = JSON.parse(process.env.QUICKRUN_FLAGS || '');
    if (Array.isArray(parsed)) {
      flags = parsed.map(String);
    }
  } catch (_) {
    // Переменной нет или она повреждена — остаются флаги по умолчанию.
  }
  return { compiler: process.env.QUICKRUN_COMPILER || 'g++', flags };
}

/**
 * Разбирает аргументы командной строки.
 * @param {string[]} argv Аргументы без node и имени скрипта.
 * @returns {{target: (string|null), rebuild: boolean, help: boolean, cmakeTarget: (string|null), programArgs: string[]}}
 */
function parseArgs(argv) {
  const result = { target: null, rebuild: false, help: false, cmakeTarget: null, programArgs: [] };
  const dashIndex = argv.indexOf('--');
  const own = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  result.programArgs = dashIndex === -1 ? [] : argv.slice(dashIndex + 1);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '-t' || a === '--target') result.cmakeTarget = own[++i] || null;
    else if (a === '-r' || a === '--rebuild') result.rebuild = true;
    else if (a === '-h' || a === '--help') result.help = true;
    else if (!result.target) result.target = a;
  }
  return result;
}

/**
 * Рекурсивно собирает файлы с нужными расширениями.
 * @param {string} dir Папка, с которой начинаем.
 * @param {Set<string>} exts Допустимые расширения (с точкой, в нижнем регистре).
 * @param {string[]} [acc] Накопитель результата.
 * @returns {string[]} Полные пути найденных файлов.
 */
function walk(dir, exts, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc; // папка недоступна — пропускаем
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walk(full, exts, acc);
      }
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Проверяет, есть ли в файле функция main.
 * @param {string} file Путь к файлу.
 * @returns {boolean}
 */
function hasMain(file) {
  return /\bmain\s*\(/.test(fs.readFileSync(file, 'utf8'));
}

/**
 * Определяет, что именно собирать.
 * @param {string|null} arg Аргумент пользователя (файл, папка или null).
 * @returns {{dir: string, target: (string|null), useCMake: boolean}} Папка проекта,
 *          главный файл (может быть null в режиме CMake) и признак CMake-проекта.
 */
function resolveTarget(arg) {
  const base = arg ? path.resolve(arg) : process.cwd();
  if (!fs.existsSync(base)) {
    fail(`Не найдено: ${base}`);
  }

  // Указали файл: берём его папку; если там CMakeLists.txt, собираем через CMake.
  if (fs.statSync(base).isFile()) {
    const dir = path.dirname(base);
    return { dir, target: base, useCMake: fs.existsSync(path.join(dir, 'CMakeLists.txt')) };
  }

  // Указали папку (или ничего): если это CMake-проект, главный файл не нужен.
  if (fs.existsSync(path.join(base, 'CMakeLists.txt'))) {
    return { dir: base, target: null, useCMake: true };
  }

  // Иначе ищем main.cpp, а затем единственный файл с main().
  const mainCpp = path.join(base, 'main.cpp');
  if (fs.existsSync(mainCpp)) {
    return { dir: base, target: mainCpp, useCMake: false };
  }
  const withMain = walk(base, SOURCE_EXT).filter(hasMain);
  if (withMain.length === 1) {
    return { dir: base, target: withMain[0], useCMake: false };
  }
  if (withMain.length === 0) {
    fail(`В папке ${base} не найден ни main.cpp, ни файл с функцией main().`);
  }
  return fail(
    'Найдено несколько файлов с main(): ' +
      withMain.map((f) => path.relative(base, f)).join(', ') +
      '\nОткройте нужный файл и запустите с ним или укажите: run файл.cpp'
  );
}

/**
 * Выбирает исходники для компиляции: главный файл и все остальные .cpp без main().
 * Так лишние «чужие» программы с main() в той же папке не мешают сборке.
 * @param {string} dir Папка проекта.
 * @param {string} target Главный файл.
 * @returns {string[]}
 */
function planSources(dir, target) {
  return walk(dir, SOURCE_EXT).filter((f) => f === target || !hasMain(f));
}

/**
 * Самое позднее время изменения среди файлов.
 * @param {string[]} files Пути к файлам.
 * @returns {number} Время в миллисекундах.
 */
function newestMtime(files) {
  return files.reduce((max, f) => Math.max(max, fs.statSync(f).mtimeMs), 0);
}

/**
 * Печатает вывод компилятора и считает ошибки и предупреждения.
 * @param {string} log Текст вывода.
 * @returns {{errors: number, warnings: number}}
 */
function reportLog(log) {
  if (log.trim()) {
    process.stdout.write(log.endsWith('\n') ? log : log + '\n');
  }
  return {
    errors: (log.match(/: (?:fatal )?error:/g) || []).length,
    warnings: (log.match(/: warning:/g) || []).length,
  };
}

/**
 * Запускает внешнюю программу и собирает её вывод.
 * @param {string} cmd Программа.
 * @param {string[]} args Аргументы.
 * @param {string} cwd Рабочая папка.
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function runCapture(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error && r.error.code === 'ENOENT') {
    fail(
      `Не найдена программа «${cmd}». Установите её и добавьте в PATH ` +
        'или укажите другой путь в настройке quickrun.compiler.'
    );
  }
  return r;
}

/**
 * Сборка напрямую компилятором (без CMake).
 * @param {string} dir Папка проекта.
 * @param {string} target Главный файл.
 * @param {{compiler: string, flags: string[]}} cfg Настройки.
 * @param {boolean} force Пересобирать даже если ничего не менялось.
 * @returns {string} Путь к готовому исполняемому файлу.
 */
function buildDirect(dir, target, cfg, force) {
  const sources = planSources(dir, target);
  const inputs = sources.concat(walk(dir, HEADER_EXT));
  const outDir = path.join(dir, '.quickrun');
  const out = path.join(outDir, path.basename(target, path.extname(target)) + EXE_SUFFIX);

  // Если бинарник новее всех исходников и заголовков, сборка не нужна.
  if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= newestMtime(inputs)) {
    console.log(color.cyan('• Исходники не менялись, сборка пропущена'));
    return out;
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(color.cyan(`• Сборка: ${sources.map((f) => path.relative(dir, f)).join(', ')}`));
  const started = Date.now();
  const r = runCapture(cfg.compiler, [...cfg.flags, ...sources, '-o', out], dir);
  const { errors, warnings } = reportLog((r.stdout || '') + (r.stderr || ''));

  if (r.status !== 0) {
    // Удаляем старый бинарник, чтобы не запустить устаревшую версию.
    fs.rmSync(out, { force: true });
    fail(`Сборка не удалась: ошибок ${errors}, предупреждений ${warnings}. Программа не запущена.`);
  }
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  const warnText = warnings ? color.yellow(`, предупреждений: ${warnings}`) : '';
  console.log(color.green(`✔ Сборка успешна за ${sec} с`) + warnText);
  return out;
}

/**
 * Разбирает CMakeLists.txt: находит все add_executable и подставляет значения
 * переменных из set(...), project(...) и перебор из foreach(...).
 * @param {string} text Содержимое CMakeLists.txt.
 * @returns {{name: string, sources: string[]}[]} Список программ и их исходников.
 */
function parseExecutables(text) {
  const clean = text.replace(/#.*$/gm, '');
  const unquote = (x) => x.replace(/^"|"$/g, '');
  /** @type {Map<string, string>} */
  const vars = new Map();
  const proj = /project\s*\(\s*([^\s)]+)/i.exec(clean);
  if (proj) vars.set('PROJECT_NAME', proj[1]);
  for (const m of clean.matchAll(/set\s*\(\s*(\w+)\s+([^)]*)\)/gi)) {
    vars.set(m[1], unquote(m[2].trim().split(/\s+/)[0]));
  }
  /** Переменные циклов: foreach(имя a b c) -> имя: [a, b, c]. @type {Map<string, string[]>} */
  const loops = new Map();
  for (const m of clean.matchAll(/foreach\s*\(\s*(\w+)\s+([^)]*)\)/gi)) {
    const items = m[2].trim().split(/\s+/).filter(Boolean).map(unquote);
    if (items.length && !['IN', 'RANGE'].includes(items[0].toUpperCase())) loops.set(m[1], items);
  }
  const expand = (str, extra) =>
    str.replace(/\$\{(\w+)\}/g, (_, v) => (extra.has(v) ? extra.get(v) : vars.get(v) || ''));

  const result = [];
  for (const m of clean.matchAll(/add_executable\s*\(\s*([^\s)]+)([^)]*)\)/gi)) {
    const rawSources = m[2].trim().split(/\s+/).filter(Boolean);
    // Если имя зависит от переменной цикла, создаём по записи на каждое значение.
    const used = [...m[1].matchAll(/\$\{(\w+)\}/g)].map((x) => x[1]);
    const loopVar = used.find((v) => !vars.has(v) && loops.has(v));
    const variants = loopVar ? loops.get(loopVar).map((it) => new Map([[loopVar, it]])) : [new Map()];
    for (const extra of variants) {
      const name = expand(m[1], extra);
      if (name && !result.some((e) => e.name === name)) {
        result.push({ name, sources: rawSources.map((x) => expand(x, extra)) });
      }
    }
  }
  return result;
}

/**
 * Рекурсивно ищет файлы с заданным именем, имеющие право на запуск.
 * Папки CMakeFiles и служебные пропускаются, недоступные папки игнорируются.
 * @param {string} root Где искать.
 * @param {string} fileName Имя файла (с .exe на Windows).
 * @param {number} depth Глубина вложенности (0 — только сама папка).
 * @param {string[]} acc Накопитель найденных путей.
 * @returns {string[]}
 */
function searchExecutable(root, fileName, depth, acc) {
  for (const f of listExecutables(root, depth, [])) {
    if (path.basename(f) === fileName) acc.push(f);
  }
  return acc;
}

/**
 * Перечисляет все исполняемые файлы в папке (без библиотек и служебных файлов).
 * @param {string} root Папка.
 * @param {number} depth Глубина вложенности (0 — только сама папка).
 * @param {string[]} acc Накопитель.
 * @returns {string[]}
 */
function listExecutables(root, depth, acc) {
  const NOT_PROGRAMS = new Set(['.dylib', '.so', '.a', '.dll', '.cmake', '.txt', '.o', '.json']);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return acc; // папки нет или она недоступна
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const skip = ['CMakeFiles', '.git', 'node_modules', '.quickrun'].includes(entry.name);
      if (!skip && depth > 0) listExecutables(full, depth - 1, acc);
    } else if (entry.isFile() && !NOT_PROGRAMS.has(path.extname(entry.name).toLowerCase())) {
      // На macOS/Linux у программы есть право на запуск; на Windows ищем .exe.
      const ok = IS_WIN ? entry.name.toLowerCase().endsWith('.exe') : (fs.statSync(full).mode & 0o111) !== 0;
      if (ok) acc.push(full);
    }
  }
  return acc;
}

/**
 * @typedef {Object} SearchRoot
 * @property {string} dir   Папка поиска.
 * @property {number} depth Глубина вложенности.
 */

/**
 * Ищет собранный файл программы в заданных папках.
 * @param {SearchRoot[]} roots Папки поиска.
 * @param {string} name Имя программы (без .exe).
 * @returns {string|null} Путь к файлу (самому свежему, если найдено несколько) или null.
 */
function findBuilt(roots, name) {
  const found = [];
  for (const r of roots) {
    searchExecutable(r.dir, name + EXE_SUFFIX, r.depth, found);
  }
  if (found.length === 0) return null;
  return found.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
}

/**
 * Выбирает, какую из программ проекта запускать.
 * Порядок: явное имя (-t) → программа, в исходниках которой есть файл → единственная собранная.
 * @param {{name: string, sources: string[]}[]} execs Известные программы проекта.
 * @param {SearchRoot[]} roots Папки, где искать собранные файлы (первая — папка сборки).
 * @param {string|null} targetFile Активный файл или null.
 * @param {string|null} wanted Имя программы, заданное через -t.
 * @returns {string} Путь к исполняемому файлу.
 */
function pickExecutable(execs, roots, targetFile, wanted) {
  if (wanted) {
    const exe = findBuilt(roots, wanted);
    return exe || fail(`Программа «${wanted}» не найдена после сборки.`);
  }
  let built = execs.filter((e) => findBuilt(roots, e.name));

  // Запасной путь: имена неизвестны — берём всё исполняемое из папки сборки.
  if (built.length === 0) {
    const names = new Set(
      listExecutables(roots[0].dir, roots[0].depth, []).map((f) => path.basename(f, EXE_SUFFIX))
    );
    built = [...names].map((name) => ({ name, sources: [] }));
  }

  if (targetFile) {
    const base = path.basename(targetFile);
    const stem = path.basename(targetFile, path.extname(targetFile));
    const byFile = built.filter((e) => e.sources.some((s) => path.basename(s) === base));
    const byName = built.filter((e) => e.name === stem);
    const match = byFile.length === 1 ? byFile : byName.length === 1 ? byName : [];
    if (match.length === 1) return findBuilt(roots, match[0].name);
  }
  if (built.length === 1) return findBuilt(roots, built[0].name);
  if (built.length === 0) {
    return fail(
      'Не удалось найти собранные программы.\n' +
        `Искал: ${execs.map((e) => e.name).join(', ') || '(имена не определены)'}\n` +
        `В папках: ${roots.map((r) => r.dir).join(', ')}\n` +
        'Если знаете имя программы, напишите: run -t имя'
    );
  }
  return fail(
    'В проекте несколько программ: ' + built.map((e) => e.name).join(', ') +
      '\nВыберите нужную: run -t имя   (или откройте её .cpp файл и нажмите Ctrl/Cmd+Alt+R)'
  );
}

/**
 * Сборка через CMake.
 * @param {string} dir Папка с CMakeLists.txt.
 * @param {{compiler: string, flags: string[]}} cfg Настройки.
 * @param {string|null} targetFile Активный файл (помогает выбрать программу).
 * @param {string|null} wanted Имя программы из параметра -t.
 * @returns {string} Путь к готовому исполняемому файлу.
 */
function buildCMake(dir, cfg, targetFile, wanted) {
  const cmakeFile = path.join(dir, 'CMakeLists.txt');
  const buildDir = path.join(dir, 'build');
  console.log(color.cyan('• Найден CMakeLists.txt, сборка через CMake'));

  // Конфигурируем, если папки сборки ещё нет или CMakeLists.txt изменился.
  const cache = path.join(buildDir, 'CMakeCache.txt');
  const needConfigure =
    !fs.existsSync(cache) || fs.statSync(cmakeFile).mtimeMs > fs.statSync(cache).mtimeMs;
  if (needConfigure) {
    const args = ['-S', dir, '-B', buildDir];
    if (IS_WIN && /g\+\+|gcc/.test(cfg.compiler) && !fs.existsSync(cache)) {
      args.push('-G', 'MinGW Makefiles', `-DCMAKE_CXX_COMPILER=${cfg.compiler}`);
    }
    const c = runCapture('cmake', args, dir);
    reportLog((c.stdout || '') + (c.stderr || ''));
    if (c.status !== 0) fail('Не удалось настроить проект (cmake).');
  }

  const b = runCapture('cmake', ['--build', buildDir], dir);
  const buildLog = (b.stdout || '') + (b.stderr || '');
  const { errors, warnings } = reportLog(buildLog);
  if (b.status !== 0) {
    fail(`Сборка не удалась: ошибок ${errors}, предупреждений ${warnings}. Программа не запущена.`);
  }
  console.log(color.green('✔ Сборка успешна') + (warnings ? color.yellow(`, предупреждений: ${warnings}`) : ''));

  // Имена программ: из CMakeLists.txt плюс из строк «Built target имя» самого CMake.
  const execs = parseExecutables(fs.readFileSync(cmakeFile, 'utf8'));
  for (const m of buildLog.matchAll(/Built target (\S+)/g)) {
    if (!execs.some((e) => e.name === m[1])) execs.push({ name: m[1], sources: [] });
  }
  // Основная папка поиска — build; рядом проверяем bin/out (частый выбор для результата).
  const roots = [
    { dir: buildDir, depth: 4 },
    { dir, depth: 0 },
    { dir: path.join(dir, 'bin'), depth: 1 },
    { dir: path.join(dir, 'out'), depth: 1 },
  ];
  return pickExecutable(execs, roots, targetFile, wanted);
}

/**
 * Запускает программу в том же терминале (ввод с клавиатуры работает).
 * @param {string} exe Путь к исполняемому файлу.
 * @param {string[]} args Аргументы программы.
 * @param {string} cwd Рабочая папка.
 */
function runProgram(exe, args, cwd) {
  console.log(color.cyan('• Запуск') + '\n' + '─'.repeat(40));
  const started = Date.now();
  const r = spawnSync(exe, args, { cwd, stdio: 'inherit' });
  const sec = ((Date.now() - started) / 1000).toFixed(2);
  console.log('\n' + '─'.repeat(40));
  if (r.error) fail(`Не удалось запустить программу: ${r.error.message}`);
  const code = r.status === null ? `сигнал ${r.signal}` : `код ${r.status}`;
  const paint = r.status === 0 ? color.green : color.red;
  console.log(paint(`Программа завершилась: ${code}, время ${sec} с`));
  process.exit(r.status === null ? 1 : r.status);
}

/**
 * Возвращает C++ файл, открытый в редакторе VS Code, если он лежит в текущей папке
 * (или её подпапке). Путь к нему плагин записывает в файл, указанный в QUICKRUN_STATE.
 * @param {string} cwd Текущая папка терминала.
 * @returns {string|null}
 */
function activeFileInside(cwd) {
  const state = process.env.QUICKRUN_STATE;
  if (!state || !fs.existsSync(state)) return null;
  const file = fs.readFileSync(state, 'utf8').trim();
  if (!file || !fs.existsSync(file)) return null;
  const rel = path.relative(cwd, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

/** Главная функция. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'QuickRun: сборка и запуск C++\n' +
        '  run                 собрать и запустить файл, открытый в редакторе (иначе main.cpp / CMake-проект)\n' +
        '  run .               игнорировать открытый файл, работать с текущей папкой\n' +
        '  run файл.cpp        собрать и запустить указанный файл\n' +
        '  run -r              пересобрать, даже если ничего не менялось\n' +
        '  run -t имя          в CMake-проекте запустить программу с этим именем\n' +
        '  run -- a b          передать программе аргументы a и b'
    );
    return;
  }
  const cfg = readConfig();
  // Без аргумента запускаем файл, открытый в редакторе (если он лежит в этой папке).
  let resolved = null;
  if (!args.target) {
    const active = activeFileInside(process.cwd());
    if (active) {
      const r = resolveTarget(active);
      // В режиме без CMake подходит только файл с main().
      if (r.useCMake || hasMain(active)) {
        console.log(color.cyan(`• Открытый файл: ${path.basename(active)}`));
        resolved = r;
      }
    }
  }
  const { dir, target, useCMake } = resolved || resolveTarget(args.target);
  const exe = useCMake
    ? buildCMake(dir, cfg, target, args.cmakeTarget)
    : buildDirect(dir, target, cfg, args.rebuild);
  runProgram(exe, args.programArgs, dir);
}

if (require.main === module) {
  main();
}

module.exports = { parseExecutables, pickExecutable, activeFileInside };
