Native speech audio converter for DM Tools
FFmpeg 7.1.1, built for macOS arm64, minimum macOS 12.0.
Source: https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
License: LGPL 2.1 or later; see ffmpeg-LICENSE.txt.
Corresponding source is included in ffmpeg-source.tar.xz.
No third-party codec libraries are linked.

Build: extract source, create a build folder, run ../ffmpeg-7.1.1/configure with:
--arch=arm64 --target-os=darwin --disable-autodetect --disable-everything --enable-ffmpeg --disable-ffplay --disable-ffprobe --disable-doc --enable-static --disable-shared --disable-avdevice --disable-network --enable-protocol='file,pipe' --enable-demuxer='mov,matroska,wav,mp3,aac,flac,ogg,asf,aiff,mxf,mpegts,mpegps' --enable-decoder='aac*,mp3*,pcm*,alac,flac,opus,vorbis,wmav1,wmav2,wmapro,wmalossless,ac3,eac3,adpcm*' --enable-parser='aac*,mpegaudio,opus,ac3,flac' --enable-muxer='wav,pcm_f32le' --enable-encoder='pcm_s16le,pcm_f32le' --enable-filter='aresample,aformat,anull,atrim,asetpts,atempo,apad,adelay,amix,abuffer,abuffersink' --extra-cflags='-mmacosx-version-min=12.0' --extra-ldflags='-mmacosx-version-min=12.0'
Then run make -j8.
