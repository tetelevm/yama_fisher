# YaMa Fisher

[Russian version](README_RU.md)

This project is a Firefox add-on for downloading music from Yandex Music.

⚠️⚠️⚠️
PIRACY IS BAD, AND THIS PROJECT CONDEMNS IT.
Any resemblance between the add-on's capabilities and downloading or
distributing content without the copyright holder's permission is purely
coincidental.
⚠️⚠️⚠️

- [about the project](#about-the-project)
- [installation](#installation)
- [questions](#questions)

## About the project

The extension helps download music from Yandex Music. It currently supports
albums only, but support for playlists, artists, and individual tracks can be
added later. Their links are recognized, but downloading is not implemented.
The extension was created exclusively for Firefox and currently works only in
Firefox, although porting it to other browsers may be possible.

It was originally based on
[Yandex Music Fisher Mod](https://github.com/vectorserver/yandex_music_fisher_mod/),
but has since been completely rewritten. It was written by neural networks
(vibe coding everywhere except this file), so explore the code at your own
risk.

Screenshots:

![starting a download](assets/imgs/s1.png)

![downloading](assets/imgs/s2.png)

![still downloading](assets/imgs/s3.png)

![final result](assets/imgs/s4.png)

## Installation

- Download the latest project release from this
  [link](https://github.com/tetelevm/yama_fisher/releases/download/v1.0.0/yama_fisher.zip).
- Open `about:debugging#/runtime/this-firefox` in a new Firefox tab.
- Under `Load Temporary Add-on…`, select the downloaded archive.
- Open an album page on Yandex Music and click the extension icon. It may be
  hidden under Firefox's general extensions icon.

Alternatively, download the entire project and point Firefox directly to
`manifest.json`. If you choose this option, you probably already know what to
do.

## Questions

For questions or suggestions, open an
[issue](https://github.com/tetelevm/yama_fisher/issues).
