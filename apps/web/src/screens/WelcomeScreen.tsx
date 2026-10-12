import { useId, useState } from "react";
import { routeHref } from "../app/routes.js";
import { useServices } from "../app/services.js";

export function WelcomeScreen() {
  const { game } = useServices();
  const id = useId();
  const [tab, setTab] = useState<"login" | "register">("login");

  return (
    <div className="welcome">
      <section className="hero" aria-labelledby={`${id}-hero`}>
        <p className="hero__mark" aria-hidden="true">
          2<sup>∞</sup>
        </p>
        <h2 id={`${id}-hero`} className="hero__title">
          Merge past 2048. Keep going.
        </h2>
        <p className="lede">
          No winning tile, no score ceiling, every value exact. Everything runs and stays on this computer.
        </p>
        <div className="action-row">
          <a className="button button--primary" href={routeHref(game ? "play" : "modes")}>
            Play as guest
          </a>
          <a className="button button--ghost" href={routeHref("modes")}>
            Browse modes
          </a>
        </div>
      </section>

      <section className="panel" aria-labelledby={`${id}-accounts`}>
        <h2 id={`${id}-accounts`} className="panel__title">
          Local account
        </h2>
        <div className="tabs" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            id={`${id}-tab-login`}
            aria-selected={tab === "login"}
            aria-controls={`${id}-panel`}
            className="tabs__tab"
            onClick={() => setTab("login")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            id={`${id}-tab-register`}
            aria-selected={tab === "register"}
            aria-controls={`${id}-panel`}
            className="tabs__tab"
            onClick={() => setTab("register")}
          >
            Create account
          </button>
        </div>
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
          <p className="badge badge--pending">Not available yet</p>
          <p>
            Accounts are created and checked by the local 2048 Infinite server (username, display name and a
            password of 12+ characters — no email or online service). This build does not connect to it yet,
            so sign-in is disabled. Guest progress is saved in this browser meanwhile.
          </p>
          <form
            className="form"
            aria-label={tab === "login" ? "Sign in" : "Create account"}
            onSubmit={(e) => e.preventDefault()}
          >
            <fieldset disabled className="form__fields">
              <div className="field">
                <label htmlFor={`${id}-user`}>Username</label>
                <input id={`${id}-user`} autoComplete="username" />
              </div>
              {tab === "register" && (
                <div className="field">
                  <label htmlFor={`${id}-display`}>Display name</label>
                  <input id={`${id}-display`} autoComplete="nickname" />
                </div>
              )}
              <div className="field">
                <label htmlFor={`${id}-pass`}>Password</label>
                <input
                  id={`${id}-pass`}
                  type="password"
                  autoComplete={tab === "login" ? "current-password" : "new-password"}
                />
              </div>
              <button type="submit" className="button button--primary">
                {tab === "login" ? "Sign in" : "Create account"}
              </button>
            </fieldset>
          </form>
        </div>
      </section>
    </div>
  );
}
