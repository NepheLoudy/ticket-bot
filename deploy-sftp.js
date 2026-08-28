/**
 * SFTP 直传部署脚本：本地打包代码 → 直传 NAS → 解压部署
 *
 * 用于本地无法访问 GitHub（443 端口不通）时绕过 GitHub 部署。
 * 用法：node deploy-sftp.js
 */
const { spawnSync } = require('child_process');
const { Client } = require('ssh2');
const os = require('os');
const path = require('path');

const TAR_NAME = 'ticket-bot-deploy.tar.gz';
const TAR_LOCAL = path.join(os.tmpdir(), TAR_NAME);
const TAR_REMOTE = '/tmp/' + TAR_NAME;

const nasConfig = {
  host: '10.253.33.233',
  port: 8500,
  username: 'qianli',
  password: 'cquqianli2026',
};

// ============ 第一步：本地打包 ============
console.log('========== [1/3] 本地打包代码 ==========');
const pack = spawnSync(
  'tar',
  [
    '-czf', TAR_LOCAL,
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=.env',
    '--exclude=logs',
    '--exclude=*.log',
    '--exclude=' + TAR_NAME,
    '.',
  ],
  { stdio: 'inherit', cwd: __dirname }
);
if (pack.status !== 0) {
  console.error('打包失败');
  process.exit(1);
}
console.log('打包完成:', TAR_LOCAL);

// ============ 第二步：SFTP 上传 ============
console.log('\n========== [2/3] SFTP 上传到 NAS ==========');
const conn = new Client();

conn.on('ready', () => {
  console.log('SSH 连接成功');
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP 失败:', err.message); conn.end(); process.exit(1); }
    sftp.fastPut(TAR_LOCAL, TAR_REMOTE, (err2) => {
      if (err2) { console.error('上传失败:', err2.message); conn.end(); process.exit(1); }
      console.log('上传完成:', TAR_REMOTE);
      execDeploy();
    });
  });
});

conn.on('error', (err) => {
  console.error('SSH 连接失败:', err.message);
  process.exit(1);
});

// ============ 第三步：NAS 解压 + 部署 ============
function execDeploy() {
  console.log('\n========== [3/3] NAS 解压 + 部署 ==========');
  const commands = [
    // 清空目录内容（qianli 对 /opt 无写权限，不能删除 /opt/ticket-bot 目录本身）
    'rm -rf /opt/ticket-bot/.git /opt/ticket-bot/* /opt/ticket-bot/.[!.]* 2>/dev/null || true',
    'tar -xzf /tmp/ticket-bot-deploy.tar.gz -C /opt/ticket-bot',
    'cd /opt/ticket-bot && npm install --production',
    'pm2 restart ticket-bot 2>/dev/null || pm2 start /opt/ticket-bot/src/index.js --name ticket-bot',
    'pm2 save',
  ];
  execNext(commands, 0);
}

function execNext(commands, i) {
  if (i >= commands.length) {
    console.log('\n部署完成，服务状态：');
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
    if (err) { console.error('执行失败:', err.message); conn.end(); process.exit(1); }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`命令失败 (退出码 ${code})`);
        conn.end();
        process.exit(code);
      }
      execNext(commands, i + 1);
    });
  });
}

console.log('正在连接 NAS...');
conn.connect(nasConfig);
