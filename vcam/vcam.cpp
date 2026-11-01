// Multistream virtual camera helper (Windows).
// Reads raw video frames (BGR, 3 bytes per pixel, top row first) from standard input and gives them
// to the "softcam" virtual camera, so Zoom and other programs can use the picture as a webcam.
// Usage: vcam.exe <width> <height> <fps>
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <fcntl.h>
#include <io.h>
#include <softcam/softcam.h>

int main(int argc, char** argv)
{
    int w = argc > 1 ? std::atoi(argv[1]) : 1280;
    int h = argc > 2 ? std::atoi(argv[2]) : 720;
    float fps = argc > 3 ? (float)std::atof(argv[3]) : 30.0f;
    if (w <= 0 || h <= 0 || w % 4 != 0) { std::fprintf(stderr, "bad size\n"); return 2; }

    _setmode(_fileno(stdin), _O_BINARY);
    scCamera cam = scCreateCamera(w, h, fps);
    if (!cam) { std::fprintf(stderr, "Could not make the virtual camera (is another program already using it?)\n"); return 3; }

    std::vector<unsigned char> frame((size_t)w * h * 3);
    for (;;)
    {
        size_t got = 0;
        while (got < frame.size())
        {
            size_t n = std::fread(frame.data() + got, 1, frame.size() - got, stdin);
            if (n == 0) { scDeleteCamera(cam); return 0; }
            got += n;
        }
        scSendFrame(cam, frame.data());
    }
}
