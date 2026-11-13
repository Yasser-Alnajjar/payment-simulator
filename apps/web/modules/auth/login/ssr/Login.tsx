import { RedirectIfSignedIn } from "../../ssr/RedirectIfSignedIn";
import { LoginForm } from "../csr/LoginForm";

export const Login = async () => (
  <RedirectIfSignedIn>
    <LoginForm />
  </RedirectIfSignedIn>
);
