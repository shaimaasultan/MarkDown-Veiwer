# Settings-change test

Every item below names an address relative to the viewer's own page. In the app the page lives at
`<token>/app/viewer.html`, so `../pref?…` would reach the program's settings, `../check/…` its Defender check and
`../fs/…` a file without the picture rules. None of them may be loaded: `Test-Viewer.cmd` fails if any address
below is requested, or if a style or picture address other than an inline picture or a file in the folder reaches
the page.

<span style="background:url(../pref?pictures=shown)">style background</span>

<span style="background-image:url('../pref?theme=dark')">quoted style url</span>

<span style="background:u\72l(../pref?size=largest)">escaped style url</span>

<span style="--x:url(../pref?width=wide);background-image:var(--x)">custom property</span>

<span style="background-image:image-set('../pref?sidebar=hidden' 1x)">image-set</span>

<span style="color: rebeccapurple">an ordinary style stays</span>

<video poster="../pref?toc=hidden" controls></video>

<video controls><track kind="captions" src="../pref?hiddenchars=on" default></video>

<audio src="../pref?pictures=blocked" controls></audio>

<img src="../check/C:/Windows/win.ini" alt="relative picture that is not in the folder">

<img srcset="../pref?theme=light 1x, ../fs/C:/Windows/Web/Screen/img100.jpg 2x" alt="srcset">

<svg width="60" height="60"><image href="../pref?types=t1" width="60" height="60"></image><image xlink:href="../fs/C:/Windows/Web/Screen/img100.jpg" width="60" height="60"></image></svg>

<svg width="60" height="60"><rect width="60" height="60" fill="url(../pref?theme=auto#p)" mask="url(../pref?size=small#m)" filter="u\72l(../pref?size=large#f)"></rect></svg>

<svg width="60" height="60"><defs><linearGradient id="ok"><stop offset="0" stop-color="teal"></stop></linearGradient></defs><rect width="60" height="60" fill="url(#ok)"></rect></svg>
