// Sends a signed .pkg to Apple and staples the approval, so it opens with no warning, even offline.
// Needs a saved login: xcrun notarytool store-credentials "network-signage"
import { execFileSync } from 'node:child_process';

const profile = process.env.APPLE_KEYCHAIN_PROFILE ?? 'network-signage';
for (const pkg of process.argv.slice(2)) {
  console.log(`Notarizing ${pkg}`);
  execFileSync('xcrun', ['notarytool', 'submit', pkg, '--keychain-profile', profile, '--wait'], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'staple', pkg], { stdio: 'inherit' });
}
