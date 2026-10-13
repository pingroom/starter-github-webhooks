import { createHmac, timingSafeEqual } from 'node:crypto';
import { linkPing } from '@pingroom/sdk';

export class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function validSignature(body, signature, secret) {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function repositoryAllowlist(value) {
  const names = value?.split(',').map((name) => name.trim().toLowerCase()) ?? [];
  if (!names.length || names.length > 50 || names.some((name) => !/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(name))) {
    throw new Error('GITHUB_REPOSITORIES must contain 1–50 comma-separated owner/repository names.');
  }
  return new Set(names);
}

const short = (value, max = 120) => [...value.replace(/\s+/gu, ' ').trim()].slice(0, max).join('');

/** The event header is a routing hint. The signed body must match its schema. */
export function eventPing(event, payload, repositories) {
  const repository = payload?.repository?.full_name;
  if (typeof repository !== 'string' || !repositories.has(repository.toLowerCase())) {
    throw new RequestError(403, 'repository_not_allowed');
  }
  if (event === 'issues') {
    if (payload.action !== 'opened') return null;
    const issue = payload.issue;
    if (!Number.isSafeInteger(issue?.number) || issue.number < 1 || typeof issue.title !== 'string' || !issue.title.trim() || payload.release) {
      throw new RequestError(400, 'invalid_issue');
    }
    return {
      title: 'GitHub issue opened',
      message: short(`${repository} #${issue.number}: ${issue.title}`),
      data: { event: 'issues.opened', repository, number: issue.number,
        ...linkPing({ url: `https://github.com/${repository}/issues/${issue.number}`, buttonLabel: 'Open issue' }) },
    };
  }
  if (event === 'release') {
    if (payload.action !== 'published') return null;
    const release = payload.release;
    if (typeof release?.tag_name !== 'string' || !release.tag_name.trim() || release.tag_name.length > 200 || payload.issue) {
      throw new RequestError(400, 'invalid_release');
    }
    return {
      title: 'GitHub release published',
      message: short(`${repository}: ${release.name || release.tag_name}`),
      data: { event: 'release.published', repository,
        ...linkPing({ url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`, buttonLabel: 'Open release' }) },
    };
  }
  return null;
}
