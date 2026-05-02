import type { Child, FC } from "hono/jsx";

// Page chrome shared by every route — reproduces the four EJS partials
// (head.ejs, nav-header.ejs, footer.ejs, scripts.ejs) as a single JSX
// component. Pages pass `title`, `subtitle`, `canonical`, plus optional
// `extraHead` for page-specific OG/Twitter tags or stylesheets, and
// optional `extraScripts` for page-specific JS.

interface LayoutProps {
  title: string;
  subtitle: string;
  canonical: string;
  // Page-specific <head> additions: extra <link rel="stylesheet">,
  // OG/Twitter tags. The EJS version inlines these per-page; collecting
  // them into a single slot keeps the per-page JSX focused on body.
  extraHead?: Child;
  extraScripts?: Child;
  children?: Child;
}

const SEASONS = Array.from({ length: 2025 - 2014 + 1 }, (_, i) => 2014 + i);

export const Layout: FC<LayoutProps> = ({
  title,
  subtitle,
  canonical,
  extraHead,
  extraScripts,
  children,
}) => {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="content-type" content="text/html; charset=UTF-8" />
        <meta http-equiv="x-ua-compatible" content="IE=edge,chrome=1" />
        <meta name="referrer" content="origin-when-cross-origin" />
        <link rel="icon" type="image/x-icon" href="/assets/img/favicon.ico" />
        <title>{title}</title>
        <meta name="title" content={title} />
        <link rel="canonical" href={canonical} />
        <meta name="description" content={subtitle} />
        <meta property="og:site_name" content="GameOnPaper.com" />
        <meta property="og:url" content={canonical} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={subtitle} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:type" content="website" />
        <meta name="twitter:site" content="Game on Paper" />
        <meta name="twitter:url" content={canonical} />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={subtitle} />
        <meta name="twitter:card" content="summary" />
        <meta name="medium" content="website" />
        <script defer data-domain="gameonpaper.com" src="https://plausible.io/js/script.js"></script>
        {extraHead}
      </head>
      <body>
        <header class="p-3 mb-3 border-bottom">
          <div class="container">
            <div class="d-flex flex-wrap align-items-center justify-content-center justify-content-lg-start">
              <div class="d-flex align-items-center mb-2 mb-lg-0 text-dark text-decoration-none me-md-3">
                <span class="fs-4 blog-header-logo">Game on Paper</span>
              </div>
              <ul class="nav col-12 col-lg-auto me-lg-auto mb-2 justify-content-center mb-md-0">
                <li>
                  <a href="/" class="nav-link px-2 link-secondary">Scoreboard</a>
                </li>
                <li class="nav-item dropdown">
                  <a class="nav-link px-2 link-secondary dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                    Leaderboards
                  </a>
                  <ul class="dropdown-menu">
                    <h6 class="dropdown-header">Team Level</h6>
                    <li><a class="dropdown-item" href="/cfb/teams/differential">Net Statistics</a></li>
                    <li><a class="dropdown-item" href="/cfb/teams/offensive">Offensive</a></li>
                    <li><a class="dropdown-item" href="/cfb/teams/defensive">Defensive</a></li>
                    <h6 class="dropdown-header">Player Level</h6>
                    <li><a class="dropdown-item" href="/cfb/players/passing">Passing</a></li>
                    <li><a class="dropdown-item" href="/cfb/players/rushing">Rushing</a></li>
                    <li><a class="dropdown-item" href="/cfb/players/receiving">Receiving</a></li>
                  </ul>
                </li>
                <li class="nav-item dropdown">
                  <a class="nav-link px-2 link-secondary dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                    Charts
                  </a>
                  <ul class="dropdown-menu">
                    <li><a class="dropdown-item" href="/cfb/charts/trends">Trends</a></li>
                    <h6 class="dropdown-header">Team Level</h6>
                    <li><a class="dropdown-item" href="/cfb/charts/team/epa">Adj EPA/Play</a></li>
                  </ul>
                </li>
                <li class="nav-item dropdown">
                  <a class="nav-link px-2 link-secondary dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                    Seasons
                  </a>
                  <ul class="dropdown-menu">
                    {SEASONS.map((yr) => (
                      <li>
                        <a class="dropdown-item" href={`/cfb/year/${yr}/teams`}>
                          {yr}
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
                <li>
                  <a href="/cfb/glossary" class="nav-link px-2 link-secondary">Glossary</a>
                </li>
              </ul>
              <form class="col-12 col-lg-auto mb-3 mb-lg-0 me-lg-3" role="search" id="game-id-form">
                <input id="inputGameId" type="search" class="form-control" placeholder="Search for an ESPN game ID..." aria-label="Search" />
              </form>
            </div>
          </div>
        </header>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.getElementById("game-id-form").addEventListener("submit", function(e) {
              e.preventDefault();
              var gameId = document.getElementById("inputGameId").value;
              window.location = "/cfb/game/" + gameId;
            });`,
          }}
        ></script>

        {children}

        <footer class="blog-footer">
          <p>
            Built by <a href="https://github.com/akeaswaran/">Akshay Easwaran</a>,{" "}
            <a href="https://github.com/saiemgilani">Saiem Gilani</a>, and others. Data from{" "}
            <a href="https://espn.com/college-football">ESPN.com</a> and{" "}
            <a href="https://collegefootballdata.com">collegefootballdata.com</a>. Please note: some box score values may be estimated due to data availability. Learn more about the stats used in our <a href="/cfb/glossary">Glossary</a>.
          </p>
          <p>
            Contribute on <a href="https://github.com/saiemgilani/game-on-paper-app">GitHub</a>. Follow the site on{" "}
            <a href="https://bsky.app/profile/gameonpaper.com">Bluesky</a>. Love the site? Support us on{" "}
            <a href="https://ko-fi.com/G2G0KJ588">Ko-fi</a>!
          </p>
          <p>
            <a href="#">Back to top</a>
          </p>
        </footer>

        <script src="/assets/js/bootstrap.bundle.min.js" crossorigin="anonymous"></script>
        <script src="/assets/js/luxon.min.js"></script>
        {extraScripts}
      </body>
    </html>
  );
};
