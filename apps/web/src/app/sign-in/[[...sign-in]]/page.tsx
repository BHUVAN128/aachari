import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return <main className="page"><h1>Clinician authentication is not configured.</h1><p className="lede">Set Clerk environment variables before approving medical content.</p></main>;
  }
  return <main className="page"><SignIn /></main>;
}
