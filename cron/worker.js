// Cloudflare cron (free, on time to the minute): starts the "Pubblica pronostici" GitHub workflow,
// because GitHub's own scheduled runs are often late by hours or skipped.
// Secret GH_TOKEN: fine-grained GitHub token, this repository only, permission "Actions: read and write".
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};

async function dispatch(env) {
  const url = `https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sporty-predict-cron',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  // 204 = run started. Anything else shows up in the Worker logs on Cloudflare.
  if (res.status !== 204) console.error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
  else console.log('GitHub workflow started');
}
