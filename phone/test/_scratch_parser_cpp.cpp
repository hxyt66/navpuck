// Temporary differential experiment: run the same split matrix through the real
// lib/navcore/nav_proto.cpp FrameParser. Delete after use.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include <string>
#include "nav_proto.h"

using namespace navpuck;

static std::vector<uint8_t> g_stream;

static std::string decode_chunks(const std::vector<std::vector<uint8_t> >& chunks) {
  FrameParser p;
  std::string out;
  char tmp[64];
  for (size_t c = 0; c < chunks.size(); ++c) {
    const std::vector<uint8_t>& ch = chunks[c];
    for (size_t i = 0; i < ch.size(); ++i) {
      FrameParser::Frame fr;
      if (p.push(ch[i], &fr)) {
        snprintf(tmp, sizeof(tmp), "%u/%u,", (unsigned)fr.type, (unsigned)fr.len);
        out += tmp;
      }
    }
  }
  return out;
}

static std::vector<uint8_t> slice(size_t a, size_t b) {
  std::vector<uint8_t> v;
  for (size_t i = a; i < b && i < g_stream.size(); ++i) v.push_back(g_stream[i]);
  return v;
}

int main(int argc, char** argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s stream.bin\n", argv[0]); return 2; }
  FILE* f = fopen(argv[1], "rb");
  if (!f) { fprintf(stderr, "open fail\n"); return 2; }
  uint8_t buf[65536];
  size_t n = fread(buf, 1, sizeof(buf), f);
  fclose(f);
  g_stream.assign(buf, buf + n);
  printf("stream_bytes %u\n", (unsigned)n);

  std::vector<std::vector<uint8_t> > whole;
  whole.push_back(g_stream);
  const std::string want = decode_chunks(whole);

  printf("whole %s\n", want.c_str());

  {
    std::vector<std::vector<uint8_t> > cs;
    for (size_t i = 0; i < g_stream.size(); ++i) cs.push_back(slice(i, i + 1));
    printf("byte %s\n", decode_chunks(cs).c_str());
  }

  {
    int bad = 0;
    for (size_t i = 1; i < g_stream.size(); ++i) {
      std::vector<std::vector<uint8_t> > cs;
      cs.push_back(slice(0, i));
      cs.push_back(slice(i, g_stream.size()));
      if (decode_chunks(cs) != want) { ++bad; if (bad < 4) printf("bad2 @%u -> %s\n", (unsigned)i, decode_chunks(cs).c_str()); }
    }
    printf("two_way_bad %d of %u\n", bad, (unsigned)(g_stream.size() - 1));
  }

  {
    std::vector<std::vector<uint8_t> > cs;
    for (size_t i = 0; i < g_stream.size(); i += 512) cs.push_back(slice(i, i + 512));
    printf("w512 %s\n", decode_chunks(cs).c_str());
  }

  {
    int bad = 0, total = 0;
    for (size_t a = 0; a <= 14; ++a) {
      for (size_t b = a; b <= 20; ++b) {
        ++total;
        std::vector<std::vector<uint8_t> > cs;
        cs.push_back(slice(0, a));
        cs.push_back(slice(a, b));
        cs.push_back(slice(b, g_stream.size()));
        if (decode_chunks(cs) != want) ++bad;
      }
    }
    printf("empty_neighborhood_bad %d of %d\n", bad, total);
  }

  {
    FrameParser p;
    for (size_t i = 0; i < g_stream.size(); ++i) { FrameParser::Frame fr; p.push(g_stream[i], &fr); }
    printf("stats frames_ok=%u crc_errors=%u resyncs=%u bad_version=%u mid=%d\n",
           (unsigned)p.framesOk(), (unsigned)p.crcErrors(), (unsigned)p.resyncs(),
           (unsigned)p.badVersion(), (int)p.isMidFrame());
  }
  return 0;
}
