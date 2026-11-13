import { RedirectIfSignedIn } from "../../ssr/RedirectIfSignedIn";
import { RegisterForm } from "../csr/RegisterForm";

export const Register = async () => (
  <RedirectIfSignedIn>
    <RegisterForm />
  </RedirectIfSignedIn>
);
