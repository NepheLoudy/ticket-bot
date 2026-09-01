/**
 * 统一部署脚本：一条命令完成「代码进 Git + 配置进 NAS + 部署」
 *
 * 用法：
 *   npm run push "提交说明"   提交并部署
 *   npm run push              使用默认提交说明 "update: 代码更新"
 *
 * 流程：
 *   [1/4] 代码提交推送到 GitHub（失败则标记，稍后改走 SFTP 直传）
 *   [2/4] 部署代码到 NAS（git push 成功走 git fetch，失败走 SFTP 打包直传）
 *   [3/4] 上传 .env 到 NAS（含飞书密钥，只单独进 NAS，绝不进 git）
 *   [4/4] npm install + 重启服务
 */
const { spawnSync } = require('child_process');
const { Client } = require('ssh2');
const os = require('os');
const path = require('path');

// NAS 连接配置从 .env 读取（NAS_HOST/NAS_PORT/NAS_USER/NAS_PASSWORD），脚本不存任何密钥
require('dotenv').config({ path: path.join(__dirname, '.env') });

const commitMessage = process.argv[2] || 'update: 代码更新';
const TAR_NAME = 'ticket-bot-deploy.tar.gz';
// 打包时用相对文件名 + cwd 指向临时目录，避免 Windows GNU tar 把 "C:" 当远程主机
const TAR_LOCAL = path.join(os.tmpdir(), TAR_NAME);
const TAR_REMOTE = '/tmp/' + TAR_NAME;

const nasConfig = {
  host: process.env.NAS_HOST,
  port: Number(process.env.NAS_PORT || 22),
  username: process.env.NAS_USER,
  password: process.env.NAS_PASSWORD,
};
if (!nasConfig.host || !nasConfig.password) {
  console.error('缺少 NAS 部署配置：请在 .env 中配置 NAS_HOST/NAS_PORT/NAS_USER/NAS_PASSWORD');
  process.exit(1);
}

// ============ [1/4] 代码提交推送到 GitHub ============
console.log('========== [1/4] 代码提交推送到 GitHub ==========');

const add = spawnSync('git', ['add', '-A'], { stdio: 'inherit' });
if (add.status !== 0) {
  console.error('git add 失败');
  process.exit(1);
}

const hasChanges = spawnSync('git', ['diff', '--cached', '--quiet']).status !== 0;
if (hasChanges) {
  const commit = spawnSync('git', ['commit', '-m', commitMessage], { stdio: 'inherit' });
  if (commit.status !== 0) {
    console.error('git commit 失败');
    process.exit(1);
  }
} else {
  console.log('(无待提交改动，跳过 commit)');
}

const push = spawnSync('git', ['push'], { stdio: 'inherit' });
const gitPushed = push.status === 0;
if (gitPushed) {
  console.log('✓ git push 成功，NAS 将通过 git fetch 拉取代码');
} else {
  console.log('⚠ git push 失败（本地无法访问 GitHub 443），改用 SFTP 直传代码到 NAS');
}

// ============ 连接 NAS ============
console.log('\n========== [2/4] 连接 NAS 部署代码 ==========');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH 连接成功');
  deployCode().catch((err) => { console.error('部署失败:', err.message); conn.end(); process.exit(1); });
});

// 执行命令并返回退出码（不中断流程，便于降级处理）
function execCode(cmd) {
  return new Promise((resolve) => {
    console.log('>', cmd);
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error('执行失败:', err.message); resolve(-1); return; }
      stream.on('data', (d) => process.stdout.write(d.toString()));
      stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
      stream.on('close', (code) => resolve(code));
    });
  });
}

conn.on('error', (err) => {
  console.error('SSH 连接失败:', err.message);
  process.exit(1);
});

// 执行单条命令（成功回调 cb）
function exec(cmd, cb) {
  console.log('>', cmd);
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('执行失败:', err.message);
      conn.end();
      process.exit(1);
    }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`命令失败 (退出码 ${code})`);
        conn.end();
        process.exit(code);
      }
      cb();
    });
  });
}

// 部署代码（git 或 SFTP 两种方式）
async function deployCode() {
  if (gitPushed) {
    // git 方式：NAS 从 GitHub 拉取（SSH 协议）
    const cmd = 'cd /opt/ticket-bot && '
      + 'if [ ! -d .git ]; then git init; fi; '
      + 'git remote set-url origin git@github.com:NepheLoudy/ticket-bot.git 2>/dev/null || git remote add origin git@github.com:NepheLoudy/ticket-bot.git; '
      + 'git fetch origin main && git reset --hard origin/main';
    const code = await execCode(cmd);
    if (code === 0) return npmInstall();
    console.log('⚠ NAS 拉取 GitHub 失败（NAS 网络不通），改用 SFTP 直传代码');
  }
  {
    // SFTP 方式：本地打包直传
    console.log('本地打包代码...');
    const pack = spawnSync('tar', [
      '-czf', TAR_NAME,
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=.env',
      '--exclude=logs',
      '--exclude=*.log',
      '--exclude=' + TAR_NAME,
      '-C', __dirname,
      '.',
    ], { stdio: 'inherit', cwd: os.tmpdir() });
    if (pack.status !== 0) {
      console.error('打包失败');
      conn.end();
      process.exit(1);
    }

    conn.sftp((err, sftp) => {
      if (err) {
        console.error('SFTP 失败:', err.message);
        conn.end();
        process.exit(1);
      }
      console.log('上传代码包到 NAS...');
      sftp.fastPut(TAR_LOCAL, TAR_REMOTE, (err2) => {
        if (err2) {
          console.error('代码上传失败:', err2.message);
          conn.end();
          process.exit(1);
        }
        console.log('✓ 代码包已上传');
        const cmd = 'rm -rf /opt/ticket-bot/.git /opt/ticket-bot/* /opt/ticket-bot/.[!.]* 2>/dev/null || true; '
          + 'tar -xzf ' + TAR_REMOTE + ' -C /opt/ticket-bot';
        exec(cmd, () => npmInstall());
      });
    });
  }
}

// npm install
function npmInstall() {
  console.log('\n安装依赖...');
  exec('cd /opt/ticket-bot && npm install --production', () => uploadEnv());
}

// ============ [3/4] 上传 .env ============
function uploadEnv() {
  console.log('\n========== [3/4] 上传 .env 到 NAS ==========');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP 失败:', err.message);
      conn.end();
      process.exit(1);
    }
    sftp.fastPut(path.join(__dirname, '.env'), '/opt/ticket-bot/.env', (err2) => {
      if (err2) {
        console.error('.env 上传失败:', err2.message);
        conn.end();
        process.exit(1);
      }
      console.log('✓ .env 已上传到 NAS（含组别路由配置）');
      restart();
    });
  });
}

// ============ [4/4] 重启服务 ============
function restart() {
  console.log('\n========== [4/4] 重启服务 ==========');
  const cmd = 'pm2 restart ticket-bot --update-env 2>/dev/null || pm2 start /opt/ticket-bot/src/index.js --name ticket-bot; pm2 save';
  exec(cmd, () => {
    console.log('\n✅ 部署完成，服务状态：');
    conn.exec('pm2 list', (err, stream) => {
      if (err) { conn.end(); return; }
      stream.on('data', (d) => process.stdout.write(d.toString()));
      stream.on('close', () => conn.end());
    });
  });
}

console.log('正在连接 NAS...');
conn.connect(nasConfig);
