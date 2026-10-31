
# Features

1. Package the game using npm as described in README.md


# General

- Loading page and pause screen should have 
    - a "fork me on github" link to encourage adaptation
    - a link to "more games on [Maize.Live](https://maize.live)"
- For now, the project should be deployed as a static website
- Prepare the project to deploy on cloudflare using wrangler with preview url = false
- Show the game's version in an unused corner of the game. 
    - template: "v.<first 4 letters of the deployed git commit>"
- If the project allows, use responsive design and make sure to use the full screen on both PC and mobile with different screen sizes and aspect ratio 
    - mobile: mid-game, transition between horizontal and vertical screen should work without incorrect scaling
    - mobile: if possible, should prevent touch-based zooms that the user can't zoom back out
- Should write scripts to play the game as a human player
    - make sure the game is balanced and fun for a human player
    - record the gameplay for reference but don't commit the recordings
    - use this to improve the gameplay and reduce bugs
- Add a link to download the entire game as a single html file to play offline



# Choice of technology

- If 3D rendering is needed, use [three.js](https://threejs.org/), unless stated otherwise
- If multiplayer is needed, use [p3p2](https://p3p2.me), unless stated otherwise
- If a Physics engine is needed, decide on what's best

