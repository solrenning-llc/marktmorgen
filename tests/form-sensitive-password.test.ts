/** GD2(c): direct requests to enter a password are refused before saving a form. */
import { sensitiveFieldOf, sensitiveKindOf } from "@/lib/form-sensitive";
import { checkGeneratedCode } from "@/lib/generated-code-check";
import { done, is, part } from "./check";

part("Direct requests for a visitor's password are refused");
for (const label of [
  "Please enter your password",
  "Enter your password",
  "Enter a password",
  "Please provide your password",
  "Provide your passcode",
  "Type your passphrase",
  "Type in your password",
  "Create your password",
  "Choose a password",
  "Confirm your password",
  "Re-enter your password",
  "Please enter your account password",
  "Enter your email password",
  "Enter your current password",
  "Enter your new password",
  "  PLEASE ENTER YOUR PASSWORD:  ",
  "Please\tenter\nyour password",
  "Please enter your password manager's password",
  // Claude 3, review 6774623744: naming a service or asking a question is still a request.
  "Enter your Instagram password",
  "Enter your login password",
  "Enter your bank password",
  "Your Instagram password",
  "Enter the password",
  "What is your password?",
  "Kindly enter your password",
  "Input your password",
  "Write your password",
  "Share your password",
  "Enter your passwords",
  "What is my account passphrase?",
  "Please enter the Instagram password",
  "Please share your bank account passcode",
  // Claude 3 focal 6778196468: service names and combined credentials.
  "Instagram password",
  "Gmail password",
  "Email & password",
  "Login (email and password)",
  "Gmail password (required)",
  "User name / password",
  "Email&password",
  "Email/password",
  "Email+password",
  "Email &password",
  "Username/password",
  "Login(email+password)",
  "Login(email/password)",
  "Gmail:password",
  "Could you share your Gmail password?",
  "Which is your password?",
  // Claude 4 (cloud D) MEDIUM on #3668: questions whose answer is the visitor's own secret.
  "What do you use as your password?",
  "Do you remember your Netflix password? If so, what is it?",
  "Which password do you use for Gmail?",
  // Claude 3 (cloud A) MEDIUM on #3668 @b624a7d4: "what" asks the same as "which" here.
  "What password do you use for Gmail?",
  "What password do you use?",
  // and the LEVE: the secret named without "your", then asked for.
  "Do you have a Netflix password? What is it?",
  "Do you reuse your passwords? Enter your password",
  "How often do you change your password? Enter your Gmail password",
  "Your feedback on my password course: enter your password",
  // Claude 1, review 6784981861: common credential combinations and wording variants.
  "Email, password",
  "Email; password",
  "Email | Password",
  "Login: email, password",
  "Instagram username, password",
  "Gmail – password",
  "Gmail — password",
  "Gmail. Password",
  "Instagram password please",
  "Instagram password here",
  "Gmail password below",
  "Account email and password please",
  "What's the password for your Instagram?",
  // Codex G, review 6797038853: a direct question for the secret, with no "your" and no "for".
  "What is the password?",
  "What is the Instagram password?",
  "What's your Instagram password?",
  "Do you mind entering your password?",
  // Claude 4 (cloud H), probes of the sentence-by-sentence rule: none of these may slip through it.
  "How about your password?",
  "Do you have your password handy? Type it here",
  "Describe your password",
  "Can I get your password?",
  "What's the wifi password?",
  // Claude 3 (cloud I): refused at 66edd3877, let through at 49b626455. The request for "it" follows a
  // comma or a short opener, not a sentence break, so a sentence-only check never saw it.
  "Do you remember your password? If yes, type it in the box",
  "Do you remember your password? If so, write it below",
  "Do you remember your password? Great, enter it here",
  "Do you have your password handy, please type it here",
  "Do you know your password? If yes type it in the box",
  // Claude 1 cloud, review @d05ed05d16 (MEDIUM): a direct ask for a named service's password, phrased with
  // "your", a trailing courtesy word, "the password you use" or "of".
  "What is your password for Instagram?",
  "What's your password for Gmail?",
  "What's your Instagram password, please?",
  "What is the password you use for Gmail?",
  "What's the password of your Instagram?",
  "What is your password to your bank?",
  "Which password do you use on Gmail, please?",
  // the two gaps also present on main, named in the same review.
  "Instagram password so we can post for you",
  "Instagram account password, needed to set up your page",
  // Codex L, review @0b7bad2f5d (MEDIUM): a typographic apostrophe (U+2019, U+2018, U+02BC) in "what's"/"where's".
  "What\u2019s your Instagram password?",
  "What\u2019s the password for Instagram?",
  "What\u2019s the password?",
  "Where\u2019s the Gmail password?",
  "What\u2019s the password you use for Gmail?",
  "What\u2018s the wifi password?",
  "What\u02BCs your Gmail password?",
  "Do you have a Netflix password? What\u2019s it?",
  // the same review (MEDIUM): a secret named with "a"/"an"/"the", then handed over as "it".
  "Do you have a Netflix password? Send it to us",
  "Do you have a Netflix password? Type it below",
  "Do you have an Instagram password? If so, enter it here",
  "Got a Netflix password? Paste it here",
  "Do you have the Gmail password? Share it with us",
  "Do you have a Netflix password? Tell us what it is",
  // the same review (MEDIUM): an email or login and the password, more than three words apart.
  "Email address and the account password",
  "Login email for the shop and its password",
  "Email address for the Instagram business account, plus the password",
  "Instagram account password and after that the login email",
] as const) {
  is(`refused: ${label}`, sensitiveKindOf(label), "password");
  const field = { id: "field1", type: "short" as const, label, required: true, options: [] };
  is(`form names the refused field: ${label}`, sensitiveFieldOf({ fields: [field] }), { label: label.trim(), what: "password" });
}

part("Questions about passwords and ordinary instructions remain available");
for (const label of [
  "What did the chapter on passwords teach you?",
  "How do you choose a password?",
  "Please enter your email",
  "Enter your password manager's name",
  "Enter a password hint",
  "Choose a password manager",
  "Please provide your feedback about password safety",
  "Describe how to create a password",
  "Please enter your postal code",
  "Type your name",
  "Choose a password manager you like",
  "What is your password manager's name?",
  "Your preferred password manager",
  "What is a password?",
  "How do you choose a passphrase?",
  // Complete habit questions do not ask the respondent to reveal a secret.
  "Do you reuse your passwords?",
  "How often do you change your password?",
  "What makes your password strong?",
  "Did you forget your password last month?",
  "Your feedback on my password course",
  "How do you use email/password sign-in?",
  "Which password manager/email tool do you use?",
  // Claude 3, review 6787874522, and Codex G, 6797038853: survey questions about passwords, refused at 66edd387.
  "How do you remember your passwords?",
  "What is your biggest frustration with password resets?",
  "Tell us about your password habits",
  "Which of your apps needs a new password most often?",
  "How many of your accounts share a password?",
  "Share your thoughts on passwords",
  "What is the best password?",
  "When did you last change your password?",
  // Claude 4 (cloud O) probe on the #3668 fix: the secret is not what is asked for here.
  "What do you use for password reminders?",
  "What do you use to store your passwords?",
  "Which password manager do you use?",
  "What password manager do you use?",
  "Do you have a password manager? What is it called?",
  "Do you remember your password? What is it like when you forget it?",
  "Why do you reuse your password?",
  // A survey question that follows one about the visitor's passwords is still a question, not a request.
  "How do you remember your passwords? Do you write them down?",
  // Controls for the fix of the review @d05ed05d16: questions about the password, not asking for it.
  "What is the password policy for your team?",
  "What is your opinion of password managers?",
  "What is the password you use most often based on?",
  "What is the best password for Gmail?",
  "What is a good password for Instagram?",
  "Password managers so we can plan the course",
  // Controls for the fix of Codex L's review @0b7bad2f5d: apostrophes, "it" and a credential far from the password.
  "What\u2019s the best password?",
  "What\u2019s a password?",
  "What\u2019s your password manager\u2019s name?",
  "Do you have a password manager? Tell us about it",
  "Do you use a strong password? Tell us why",
  "What did the chapter on passwords teach you? Write it below",
  "Your email (we never ask for a password)",
  "Email address, and we will send password tips",
  "Email address and what you think about passwords",
  "How do you use email sign-in and, at work, a password?",
]) is(`kept: ${label}`, sensitiveKindOf(label), null);

part("Generated forms use the same refusal for labels and accessible input names");
for (const html of [
  '<label>Please enter your password<input type="text"></label>',
  '<input type="text" aria-label="Please provide your password">',
  '<input type="text" placeholder="Type your passphrase">',
  '<label>Instagram password<input type="text"></label>',
  '<input type="text" aria-label="Gmail password">',
  '<input type="text" placeholder="Email &amp; password">',
  '<input type="text" aria-label="Email&amp;password">',
  '<input type="text" placeholder="Login(email/password)">',
  '<label>Login (email and password)<input type="text"></label>',
  '<label>Email, password<input type="text"></label>',
  '<input type="text" aria-label="Gmail — password">',
  '<input type="text" placeholder="What\'s the password for your Instagram?">',
  '<input type="text" aria-label="What is your password for Instagram?">',
  '<label>What\'s your Instagram password, please?<input type="text"></label>',
]) {
  const result = checkGeneratedCode({ html, css: "", js: "" });
  is("a direct password request cannot pass the generated-code check", result.staticPass, false);
  is("the password request is identified", result.findings.some((finding) => finding.rule === "sensitive_field"), true);
}

done();
