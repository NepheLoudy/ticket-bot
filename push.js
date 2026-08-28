/**
 * 一键部署脚本：提交代码到 GitHub 并部署到 NAS
 *
 * 用法：
 *   node push.js "提交说明"   提交并部署
 *   node push.js              使用默认提交说明 "update: 代码更新"
 */
const { spawnSync } = require('child_process');
const { Client } = require('ssh2');

const commitMessage = process.argv[2] || 'update: 代码更新';

// NAS 连接配置
const nasConfig = {
  host: '10.253.33.233',
  port: 8500,
  username: 'qianli',
  password: 'cquqianli2026',
};

function run(cmd, args) {
  console.log('>', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n命令失败: ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

// ============ 第一步：提交并推送到 GitHub ============
console.log('========== [1/2] 提交并推送代码到 GitHub ==========');

run('git', ['add', '-A']);

// 检查是否有待提交的改动，避免空 commit 报错
const hasChanges = spawnSync('git', ['diff', '--cached', '--quiet']).status !== 0;
if (hasChanges) {
  run('git', ['commit', '-m', commitMessage]);
} else {
  console.log('(无待提交改动，跳过 commit)');
}

run('git', ['push']);

// ============ 第二步：部署到 NAS ============
console.log('\n========== [2/2] 部署到 NAS ==========');

const commands = [
  // 首次部署：目录不存在则 clone；后续更新：fetch + reset
  'if [ -d /opt/ticket-bot/.git ]; then cd /opt/ticket-bot && git fetch origin main && git reset --hard origin/main; else git clone https://github.com/NepheLoudy/ticket-bot.git /opt/ticket-bot; fi',
  'cd /opt/ticket-bot && npm install --production',
  // 已部署则重启，未部署则启动
  'pm2 restart ticket-bot 2>/dev/null || pm2 start /opt/ticket-bot/src/index.js --name ticket-bot',
  'pm2 save',
];

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH 连接成功\n');
  execNext(0);
});

conn.on('error', (err) => {
  console.error('SSH 连接失败:', err.message);
  process.exit(1);
});

function execNext(i) {
  if (i >= commands.length) {
    console.log('\n部署完成，服务状态如下：');
    conn.exec('pm2 list', (err, stream) => {
      if (err) { conn.end(); return; }
      stream.on('data', (d) => process.stdout.write(d.toString()));
      stream.on('close', () => conn.end());
    });
    return;
  }

  const cmd = commands[i];
  console.log('>', cmd);
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('执行失败:', err.message);
      conn.end();
      return;
    }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`命令失败 (退出码 ${code})`);
        conn.end();
        process.exit(code);
      }
      execNext(i + 1);
    });
  });
}

console.log('正在连接 NAS...');
conn.connect(nasConfig);
