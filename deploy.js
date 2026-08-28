const { Client } = require('ssh2');
const { execSync } = require('child_process');

const config = {
  host: '10.253.33.233',
  port: 8500,
  username: 'qianli',
  password: 'cquqianli2026'
};

function runGitCommands() {
  console.log('\n=== 步骤1: 提交代码到 GitHub ===');

  try {
    console.log('检查 git 状态...');
    const status = execSync('git status --porcelain').toString().trim();
    if (!status) {
      console.log('❌ 没有需要提交的更改');
      return false;
    }

    console.log('添加所有文件...');
    execSync('git add -A');

    console.log('提交更改...');
    execSync('git commit -m "chore: 自动部署更新"');

    console.log('推送代码到 GitHub...');
    execSync('git push origin main');

    console.log('✅ 代码已推送到 GitHub');
    return true;
  } catch (err) {
    console.error('❌ Git 操作失败:', err.message);
    return false;
  }
}

const commands = [
  { cmd: 'mkdir -p /opt/ticket-bot', sudo: true },
  { cmd: 'chown -R qianli:qianli /opt/ticket-bot', sudo: true },
  { cmd: 'cd /opt/ticket-bot && if [ -d .git ]; then git fetch origin main && git reset --hard origin/main; else git init && git remote add origin https://github.com/NepheLoudy/ticket-bot.git && git fetch origin main && git reset --hard origin/main; fi', sudo: false },
  { cmd: 'cd /opt/ticket-bot && npm install --production', sudo: false },
  { cmd: `cat > /opt/ticket-bot/.env << 'ENVEOF'
PORT=3003
# 飞书应用配置（qianli 项目群共用应用）
APP_ID=cli_aac7e6f6cdf8dcc0
APP_SECRET=Z11s3UBWL2pivBCcc1zJnfJInKWmaYjN
# 源表：「【27赛季】千里工单系统」
BITABLE_APP_TOKEN=ZlVZbXDkRayUzSsFRiycznmZn5b
SOURCE_TABLE_ID=tblFA6Pj4Mv83Mb0
# 目标表：「tbl_project」项目看板（同一多维表格）
TARGET_BITABLE_APP_TOKEN=
TARGET_TABLE_ID=tblIcyn9814CsgaH
# 字段映射
FIELD_MAPPING=
SYNC_KEY_FIELD=源记录ID
CATEGORY_FIELD=category
# 工单播报字段
ROUTE_FIELD=面向组别
GROUP_ROUTES=
DEFAULT_CHAT_ID=
TITLE_FIELD=申请编号
STATUS_FIELD=申请状态
PENDING_STATUS=
DISPLAY_FIELDS=需求,发起人,理想结单时间,发起人部门
# 是否指定人员负责分支
ASSIGN_FIELD=是否指定人员负责
ASSIGN_YES_VALUE=是
ASSIGN_NO_VALUE=否
ASSIGNEE_FIELD=指定负责人
USER_GROUPS=
# 组长映射
GROUP_LEADERS=
# 事件订阅
BROADCAST_ON=create
FEISHU_USE_LONG_CONNECTION=true
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
BOT_NAME=工单机器人
# 每日汇总
CRON_SCHEDULE=
ENVEOF`, sudo: false },
  { cmd: 'pm2 delete ticket-bot 2>/dev/null || true', sudo: false },
  { cmd: 'pm2 start /opt/ticket-bot/src/index.js --name ticket-bot', sudo: false },
  { cmd: 'pm2 save', sudo: false },
  { cmd: 'ufw allow 3003/tcp', sudo: true }
];

function deployToNAS() {
  const conn = new Client();

  conn.on('ready', () => {
    console.log('\nSSH连接成功！');
    executeNextCommand(conn, 0);
  });

  conn.on('error', (err) => {
    console.error('SSH连接失败:', err.message);
    process.exit(1);
  });

  conn.on('end', () => {
    console.log('SSH连接已关闭');
  });

  console.log('\n=== 步骤2: 部署到 NAS ===');
  console.log('正在连接到 NAS...');
  conn.connect(config);
}

function executeNextCommand(conn, index) {
  if (index >= commands.length) {
    console.log('\n✅ 所有命令执行完成！');
    conn.end();
    return;
  }

  const { cmd, sudo } = commands[index];
  const displayCmd = cmd.substring(0, 60) + (cmd.length > 60 ? '...' : '');
  console.log(`\n[${index + 1}/${commands.length}] 执行${sudo ? '(sudo)' : ''}: ${displayCmd}`);

  const execCmd = sudo ? `echo "cquqianli2026" | sudo -S ${cmd}` : cmd;

  conn.exec(execCmd, (err, stream) => {
    if (err) {
      console.error('命令执行失败:', err.message);
      conn.end();
      return;
    }

    stream.on('data', (data) => {
      const output = data.toString().trim();
      if (output && !output.includes('[sudo] password') && !output.includes('cquqianli2026')) {
        console.log(output);
      }
    });

    stream.stderr.on('data', (data) => {
      const error = data.toString().trim();
      if (error && !error.includes('[sudo] password') && !error.includes('cquqianli2026')) {
        console.error('错误:', error);
      }
    });

    stream.on('close', (code) => {
      if (code === 0) {
        console.log(`命令执行成功 (退出码: ${code})`);
        executeNextCommand(conn, index + 1);
      } else {
        console.error(`命令执行失败 (退出码: ${code})`);
        conn.end();
      }
    });
  });
}

async function main() {
  const hasChanges = runGitCommands();

  if (!hasChanges) {
    console.log('\n=== 跳过部署 ===');
    process.exit(0);
  }

  deployToNAS();
}

main();
