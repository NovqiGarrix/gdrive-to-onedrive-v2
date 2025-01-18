# Introduction
Transfer files from google drive to one drive (or vice versa) using Deno.

## Overview
Overall, the program is already working. You can transfer files from google drive to one drive (but not vice versa yet). Please CHECK the limitations section below.

## Todo
- [x] Setup google authentication
- [x] Setup microsoft authentication
- [x] Transfer file(s) from google drive to one drive
- [x] Add support delete file after transfer

## Limitations
1. Shared with me files in google drive are not supported yet.
2. Checking file existence in one drive is done by getting all of the files in a certain folder (root folder by default) and checking the name of the file. This is not efficient for large number of files.
