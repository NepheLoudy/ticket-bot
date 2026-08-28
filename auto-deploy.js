/**
 * 基于 GitHub Actions 的自动部署脚本
 *
 * 流程：
 *   1. 检查本地是否有未提交的更改
 *   2. 自动 commit & push 到 GitHub main 分支
 *   3. 轮询 GitHub Actions 运行状态，等待自动部署完成
 *
 * 前置条件：
 *   - 已配置 git remote origin 指向 GitHub 仓库
 *   - 已安装 GitHub CLI (gh) 并完成登录认证
 *   - GitHub 仓库已配置以下 Secrets（见 .github/workflows/deploy.yml）：
 *     SSH_PRIVATE_KEY, SERVER_HOST, SERVER_USER, SERVER_PORT, DEPLOY_PATH
 *     APP_ID, APP_SECRET, BITABLE_APP_TOKEN, SOURCE_TABLE_ID, TARGET_TABLE_ID
 *     GROUP_ROUTES, GROUP_LEADERS
 *
 * 使用方式：npm run auto-deploy
 */
const { exec } = require('child_process');
const path = require('path');

async function runCommand(cmd, cwd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stdout, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function main() {
  console.log('🚀 一键部署脚本启动（GitHub Actions 模式）\n');

  const projectRoot = path.dirname(__filename);

  try {
    console.log('📤 检查 git 状态...');
    const statusResult = await runCommand('git status --porcelain', projectRoot);

    if (!statusResult.stdout.trim()) {
      console.log('❌ 没有未提交的更改，无需部署');
      process.exit(0);
    }

    console.log('✅ 发现未提交的更改');
    console.log('文件变更:', statusResult.stdout.trim().split('\n').map(l => l.trim()).filter(l => l));

    console.log('\n📝 自动生成提交信息...');
    const dateStr = new Date().toLocaleString('zh-CN');
    const commitMsg = `auto-deploy: 更新于 ${dateStr}`;
    console.log(`提交信息: ${commitMsg}`);

    console.log('\n📦 暂存所有文件...');
    await runCommand('git add -A', projectRoot);

    console.log('\n✅ 执行 git commit...');
    const commitResult = await runCommand(`git commit -m "${commitMsg}"`, projectRoot);
    console.log(commitResult.stdout.trim());

    console.log('\n🚀 执行 git push...');
    const pushResult = await runCommand('git push origin main', projectRoot);
    console.log(pushResult.stdout.trim() || pushResult.stderr.trim());

    console.log('\n⏳ 等待 GitHub Actions 部署...');
    console.log('预计需要 1-3 分钟，请耐心等待...');

    let attempts = 0;
    const maxAttempts = 30;
    const checkInterval = 10000;

    while (attempts < maxAttempts) {
      attempts++;
      await new Promise(r => setTimeout(r, checkInterval));

      try {
        console.log(`\n🔍 第 ${attempts}/${maxAttempts} 次检查部署状态...`);

        const deployResult = await runCommand(
          'gh run list --workflow=deploy.yml --limit=1 --json=status,conclusion --jq=.[]',
          projectRoot
        );

        if (deployResult.stdout) {
          const status = JSON.parse(deployResult.stdout);
          console.log(`当前状态: ${status.status} ${status.conclusion ? '(' + status.conclusion + ')' : ''}`);

          if (status.status === 'completed' && status.conclusion === 'success') {
            console.log('\n🎉 部署成功！');
            console.log('服务已自动重启，新配置立即生效');
            process.exit(0);
          } else if (status.status === 'completed' && status.conclusion === 'failure') {
            console.log('\n❌ 部署失败！');
            console.log('请查看 GitHub Actions 日志了解详情');
            process.exit(1);
          }
        }
      } catch (err) {
        console.log(`检查中... (${attempts * 10}秒)`);
      }
    }

    console.log('\n⏰ 部署超时，请手动检查 GitHub Actions 状态');
    process.exit(1);

  } catch (err) {
    console.error('\n❌ 部署过程出错:', err.error?.message || err);
    if (err.stderr) console.error('错误输出:', err.stderr);
    process.exit(1);
  }
}

main();
