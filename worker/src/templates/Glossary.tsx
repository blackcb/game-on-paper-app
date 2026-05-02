import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import type { Glossary } from "../lib/glossary";

interface Props {
  glossary: Glossary;
}

export const GlossaryPage: FC<Props> = ({ glossary }) => {
  const letters = Object.keys(glossary);
  const extraHead = (
    <>
      <link href="/assets/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous" />
      <link href="/assets/css/dashboard.css" rel="stylesheet" />
      <link href="/assets/css/blog.css" rel="stylesheet" />
      <link href="/assets/css/dark-game.css" rel="stylesheet" />
      <link href="/assets/css/bootstrap-icons/bootstrap-icons.css" rel="stylesheet" />
    </>
  );
  return (
    <Layout
      title="Glossary | College Football | Game on Paper"
      subtitle="Advanced stats glossary for college football"
      canonical="https://gameonpaper.com/cfb/glossary"
      extraHead={extraHead}
    >
      <div class="container-fluid">
        <nav class="nav d-flex justify-content-center">
          {letters.flatMap((k, idx) => {
            const items = [
              <a class="link-primary p-2" href={`#glossary-section-${k}`} key={`link-${k}`}>
                {k.toUpperCase()}
              </a>,
            ];
            if (idx !== letters.length - 1) {
              items.push(
                <span class="p align-self-center" key={`sep-${k}`}>
                  &#9899;
                </span>,
              );
            }
            return items;
          })}
        </nav>
      </div>
      <div class="container">
        {letters.map((k) => (
          <div key={`section-${k}`}>
            <h2 id={`glossary-section-${k}`}>{k.toUpperCase()}</h2>
            {glossary[k].map((r) => (
              <dl class="row" key={`${k}-${r.term}`}>
                {r.source ? (
                  <dt class="col-sm-3">
                    <a href={r.source}>{r.term}</a>
                  </dt>
                ) : (
                  <dt class="col-sm-3">{r.term}</dt>
                )}
                {/* `definition` is HTML — the EJS template uses `<%- %>` (unescaped). */}
                <dd class="col-sm-9" dangerouslySetInnerHTML={{ __html: r.definition }}></dd>
              </dl>
            ))}
          </div>
        ))}
      </div>
    </Layout>
  );
};
