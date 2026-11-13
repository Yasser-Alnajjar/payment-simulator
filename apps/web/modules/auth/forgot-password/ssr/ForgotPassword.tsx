import { RedirectIfSignedIn } from "../../ssr/RedirectIfSignedIn";
import { ForgotPasswordForm } from "../csr/ForgotPasswordForm";

export const ForgotPassword = async () => (
  <RedirectIfSignedIn>
    <ForgotPasswordForm />
  </RedirectIfSignedIn>
);
