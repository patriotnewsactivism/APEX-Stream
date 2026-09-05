// Invites an operator via Identity Platform: creates the user if needed,
// sets their role as a custom claim, and prints a password-reset link.
//
// Identity Platform has no equivalent of Cognito's admin-create-user, which
// emails a temporary password automatically -- there is no delivery channel
// wired up here, so the link is printed to the job summary for a human to
// relay rather than silently assumed to reach the invitee.

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { appendFileSync } from 'node:fs';

const email = process.env.EMAIL;
const role = process.env.ROLE;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

if (!email || !role) {
  console.error('EMAIL and ROLE must be set');
  process.exit(1);
}

const app = initializeApp({ credential: applicationDefault() });
const auth = getAuth(app);

let user;
try {
  user = await auth.getUserByEmail(email);
} catch (err) {
  if (err.code !== 'auth/user-not-found') throw err;
  user = await auth.createUser({ email, emailVerified: false });
}

await auth.setCustomUserClaims(user.uid, { roles: [role] });
const resetLink = await auth.generatePasswordResetLink(email);

const summary = `Invited **${email}** as **${role}**.\n\n` +
  `Identity Platform does not send this automatically -- send the invitee this link ` +
  `so they can set a password:\n\n${resetLink}\n`;
console.log(summary);
if (summaryPath) appendFileSync(summaryPath, summary);
