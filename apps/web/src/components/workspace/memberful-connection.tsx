import { useRef, useState, type FormEvent } from "react";
import { MAX_PASSWORD_LENGTH, type MemberfulAccount, type ProfileAnswer } from "@ember/protocol";
import { AUTH_FORM } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { connectMemberful, disconnectMemberful, isSignedOut } from "@/lib/api";
import { openPage } from "@/lib/page";
import { pushEndpoint } from "@/lib/push";

// The Papaya section of your profile: while Papaya is members only, someone with an account from
// before connects their Papaya account to it, with their password, as changing their email address
// takes it, and signs in with Papaya from then on. Once one is connected, it names the account, and
// Disconnect Papaya, with their password again, unlinks it and ends their other sessions, as a new
// password does, while they have a password and an email address to sign in with instead. Someone who
// joined with Papaya has no password, and is given none while Papaya signs them in, so theirs
// stays connected. Boxed as workspace settings' Papaya section is.

interface Props {
  /** The Papaya account you've connected, as Papaya describes it, or null while you haven't. */
  connected: MemberfulAccount | null;
  /** Whether Papaya is members only, when members sign in with Papaya alone, unless they need no membership. */
  membersOnly: boolean;
  /** Whether you have a password, which connecting one asks for then, and disconnecting it needs. */
  hasPassword: boolean;
  /** Whether you have an email address, which signing in with your password takes, so disconnecting needs it too. */
  hasEmailAddress: boolean;
  /** Whether you need Papaya to sign in, as everyone does but administrators and the people they invite, who sign in with a password too. */
  membershipNeeded: boolean;
  /** Shows your profile as disconnecting answered it. */
  onDisconnected: (answer: ProfileAnswer) => void;
  /** Says why connecting didn't start, or disconnecting didn't work, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Who `account` is, as Papaya describes it: "Grace Hopper (grace@example.com)", or whichever of the two it said, or null when it said neither. */
function describe({ name, emailAddress }: MemberfulAccount): string | null {
  if (name && emailAddress) return `${name} (${emailAddress})`;
  return name || emailAddress || null;
}

/**
 * The Papaya account you've connected, with Disconnect Papaya, or Connect Papaya, which sends
 * the browser to sign in at the Papaya site once your password checks out, and Papaya sends it
 * back here.
 */
export function MemberfulConnection({ connected, membersOnly, hasPassword, hasEmailAddress, membershipNeeded, onDisconnected, onFailed }: Props) {
  const [busy, setBusy] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const mounted = useMounted();

  /** Once connecting has failed, or disconnecting has answered: ready for another try, with the password field emptied. */
  const settle = () => {
    setBusy(false);
    if (passwordInput.current) passwordInput.current.value = "";
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    connectMemberful(hasPassword ? (passwordInput.current?.value ?? "") : undefined).then(
      ({ memberfulConnection }) => openPage(memberfulConnection),
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        settle();
        onFailed(error);
      },
    );
  };

  const disconnect = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const currentPassword = passwordInput.current?.value ?? "";
    // With this browser's push subscription named, which it keeps while it forgets the rest of your browsers'.
    pushEndpoint()
      .then((endpoint) => disconnectMemberful(endpoint ? { currentPassword, pushSubscriptionEndpoint: endpoint } : { currentPassword }))
      .then(
        (answer) => {
          if (!mounted.current) return;
          settle();
          onDisconnected(answer);
        },
        (error: unknown) => {
          if (!mounted.current && !isSignedOut(error)) return;
          settle();
          onFailed(error);
        },
      );
  };

  /** The password field, as both forms have it, described by the form's help, `helpId`: uncontrolled, as the profile's password fields are. */
  const passwordField = (helpId: string) => (
    <Field id="memberful_password" label="Password" translation="password">
      <Input
        ref={passwordInput}
        id="memberful_password"
        type="password"
        required
        autoComplete="current-password"
        placeholder="Enter your password"
        maxLength={MAX_PASSWORD_LENGTH}
        aria-describedby={helpId}
        className={FIELD_INPUT}
      />
    </Field>
  );

  // Whether your password signs you in, which takes an email address to sign in by, so that Papaya can be disconnected.
  const signsInWithPassword = hasPassword && hasEmailAddress;
  // Whether Papaya is your way in, rather than one of two: a member's, while Papaya is members only,
  // and anyone's whose password doesn't sign them in.
  const signsYouIn = (membersOnly && membershipNeeded) || !signsInWithPassword;
  const who = connected && describe(connected);

  return (
    <section aria-labelledby="memberful-connection-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id="memberful-connection-heading" className="text-base font-semibold">
        Papaya
      </h2>
      {connected ? (
        <>
          <p>
            {who ? `Connected to Papaya as ${who}` : "Your Papaya account is connected"}
            {signsYouIn ? ", so you sign in with it." : ", so you can sign in with it too."}
          </p>
          {signsInWithPassword ? (
            <form onSubmit={disconnect} className={AUTH_FORM}>
              <p id="memberful-disconnection-help">
                {signsYouIn
                  ? "Disconnecting ends your other sessions. Signing in with your password then asks you to connect one again."
                  : "Disconnecting ends your other sessions, as a new password does."}
              </p>
              {passwordField("memberful-disconnection-help")}
              <SubmitButton disabled={busy}>Disconnect Papaya</SubmitButton>
            </form>
          ) : (
            hasPassword && <p>Add your email address above to disconnect it, so that you can still sign in with your password.</p>
          )}
        </>
      ) : (
        <form onSubmit={connect} className={AUTH_FORM}>
          <p id="memberful-connection-help">
            Members sign in with Papaya.{" "}
            {membershipNeeded ? "Connect your Papaya account to keep signing in as yourself." : "Connect your Papaya account to sign in with it too."}
          </p>
          {hasPassword && passwordField("memberful-connection-help")}
          <SubmitButton disabled={busy}>Connect Papaya</SubmitButton>
        </form>
      )}
    </section>
  );
}
