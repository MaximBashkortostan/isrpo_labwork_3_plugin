'use strict';

/**
 * @file Точка входа плагина QuickRun для VS Code.
 *
 * Что делает плагин:
 *  1. Кладёт в PATH встроенного терминала короткую команду (по умолчанию `run`).
 *     Команда запускает src/cli.js: сборка C++ и запуск программы.
 *  2. Регистрирует команду палитры/горячую клавишу/кнопку в статус-баре,
 *     которые делают то же самое без ручного ввода.
 *  3. Автоматически сохраняет изменённые C/C++ файлы.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

/** Имя терминала, в котором плагин запускает сборку. */
const TERMINAL_NAME = 'QuickRun';

/** Через сколько миллисекунд после правки файл сохраняется автоматически. */
const SAVE_DELAY_MS = 500;

/** Языки, файлы которых сохраняются автоматически. */
const SAVE_LANGS = new Set(['cpp', 'c']);

/**
 * Таймеры отложенного сохранения: ключ — адрес файла, значение — таймер.
 * Если файл правят снова, прежний таймер сбрасывается (debounce).
 * @type {Map<string, NodeJS.Timeout>}
 */
const saveTimers = new Map();

/**
 * @typedef {Object} QuickRunConfig
 * @property {string} compiler    Компилятор.
 * @property {string[]} flags     Флаги компиляции.
 * @property {string} commandName Имя команды в терминале.
 * @property {boolean} autoSave   Включено ли автосохранение.
 */

/**
 * Читает настройки плагина из settings.json.
 * @returns {QuickRunConfig}
 */
function getConfig() {
  const c = vscode.workspace.getConfiguration('quickrun');
  const rawName = String(c.get('commandName', 'run'));
  // В имени команды оставляем только буквы, цифры, «_» и «-».
  const name = rawName.replace(/[^\w-]/g, '') || 'run';
  return {
    compiler: c.get('compiler', 'g++'),
    flags: c.get('flags', ['-std=c++17', '-Wall']),
    commandName: name,
    autoSave: c.get('autoSave', true),
  };
}

/**
 * Создаёт папку с исполняемым скриптом-командой.
 * Скрипт запускает cli.js, используя тот же движок, что и сам VS Code
 * (режим ELECTRON_RUN_AS_NODE), поэтому отдельно ставить Node.js не нужно.
 * @param {vscode.ExtensionContext} context Контекст плагина.
 * @param {QuickRunConfig} cfg Настройки.
 * @returns {string} Путь к папке со скриптом.
 */
function installScripts(context, cfg) {
  const binDir = path.join(context.globalStorageUri.fsPath, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Удаляем старые скрипты (например, если сменилось имя команды).
  for (const f of fs.readdirSync(binDir)) {
    fs.rmSync(path.join(binDir, f), { force: true });
  }

  const cli = context.asAbsolutePath(path.join('src', 'cli.js'));
  const exec = process.execPath;

  if (IS_WIN) {
    const body =
      '@echo off\r\n' +
      'setlocal\r\n' +
      'set ELECTRON_RUN_AS_NODE=1\r\n' +
      `"${exec}" "${cli}" %*\r\n` +
      'exit /b %errorlevel%\r\n';
    fs.writeFileSync(path.join(binDir, `${cfg.commandName}.cmd`), body);
  } else {
    const body =
      '#!/bin/sh\n' +
      `ELECTRON_RUN_AS_NODE=1 exec "${exec}" "${cli}" "$@"\n`;
    fs.writeFileSync(path.join(binDir, cfg.commandName), body, { mode: 0o755 });
  }
  return binDir;
}

/**
 * Путь к файлу, в котором хранится последний открытый C++ файл.
 * Его читает cli.js, чтобы команда `run` без аргументов запускала то, что открыто в редакторе.
 * @param {vscode.ExtensionContext} context Контекст плагина.
 * @returns {string}
 */
function activeFileStatePath(context) {
  return path.join(context.globalStorageUri.fsPath, 'active-file.txt');
}

/**
 * Запоминает открытый в редакторе C++ файл.
 * @param {vscode.ExtensionContext} context Контекст плагина.
 * @param {vscode.TextEditor|undefined} editor Активный редактор.
 */
function rememberActiveFile(context, editor) {
  if (!editor || editor.document.uri.scheme !== 'file') {
    return;
  }
  const file = editor.document.fileName;
  if (!/\.(cpp|cc|cxx)$/i.test(file)) {
    return;
  }
  try {
    fs.writeFileSync(activeFileStatePath(context), file);
  } catch (_) {
    // Не удалось записать — не критично, просто не будет автовыбора файла.
  }
}

/**
 * Передаёт новым терминалам PATH с нашей командой и настройки компилятора.
 * @param {vscode.ExtensionContext} context Контекст плагина.
 * @param {QuickRunConfig} cfg Настройки.
 * @param {string} binDir Папка со скриптом.
 */
function applyEnvironment(context, cfg, binDir) {
  const env = context.environmentVariableCollection;
  env.clear();
  env.prepend('PATH', binDir + path.delimiter);
  env.replace('QUICKRUN_COMPILER', cfg.compiler);
  env.replace('QUICKRUN_FLAGS', JSON.stringify(cfg.flags));
  env.replace('QUICKRUN_STATE', activeFileStatePath(context));
}

/**
 * Команда «Собрать и запустить»: сохраняет файлы и отправляет команду в терминал QuickRun.
 * @param {QuickRunConfig} cfg Настройки.
 */
async function startFromEditor(cfg) {
  // Файл читаем до показа терминала, пока активен редактор.
  const editor = vscode.window.activeTextEditor;
  let arg = '';
  if (
    editor &&
    editor.document.uri.scheme === 'file' &&
    /\.(cpp|cc|cxx)$/i.test(editor.document.fileName)
  ) {
    arg = ` "${editor.document.fileName}"`;
  }

  await vscode.workspace.saveAll(false);

  let term = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
  if (!term) {
    term = vscode.window.createTerminal({ name: TERMINAL_NAME });
  }
  term.show(true);
  term.sendText(cfg.commandName + arg);
}

/**
 * Планирует автосохранение документа (с задержкой).
 * @param {vscode.TextDocument} doc Изменённый документ.
 */
function scheduleSave(doc) {
  if (doc.uri.scheme !== 'file' || !SAVE_LANGS.has(doc.languageId)) {
    return;
  }
  const key = doc.uri.toString();
  clearTimeout(saveTimers.get(key));
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key);
      if (doc.isDirty) {
        doc.save();
      }
    }, SAVE_DELAY_MS)
  );
}

/**
 * Вызывается VS Code при активации плагина.
 * @param {vscode.ExtensionContext} context Контекст плагина.
 */
function activate(context) {
  let cfg = getConfig();
  let binDir = installScripts(context, cfg);
  applyEnvironment(context, cfg, binDir);

  rememberActiveFile(context, vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => rememberActiveFile(context, e))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('quickrun.start', () => startFromEditor(getConfig()))
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(play) QuickRun';
  status.tooltip = 'Собрать и запустить (Ctrl+Alt+R)';
  status.command = 'quickrun.start';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (getConfig().autoSave) {
        scheduleSave(e.document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('quickrun')) {
        return;
      }
      cfg = getConfig();
      binDir = installScripts(context, cfg);
      applyEnvironment(context, cfg, binDir);
      vscode.window.showInformationMessage(
        'QuickRun: настройки изменились. Откройте новый терминал, чтобы они применились.'
      );
    })
  );
}

/** Вызывается при выключении плагина: очищает таймеры. */
function deactivate() {
  for (const t of saveTimers.values()) {
    clearTimeout(t);
  }
  saveTimers.clear();
}

module.exports = { activate, deactivate };
