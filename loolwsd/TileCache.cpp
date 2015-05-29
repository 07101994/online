/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4; fill-column: 100 -*- */
/*
 * This file is part of the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#include "config.h"

#include <cassert>
#include <climits>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>

#include <Poco/DirectoryIterator.h>
#include <Poco/File.h>
#include <Poco/Path.h>
#include <Poco/SHA1Engine.h>
#include <Poco/StringTokenizer.h>
#include <Poco/Util/Application.h>

#include "TileCache.hpp"

TileCache::TileCache(const std::string& docURL) :
    _docURL(docURL)
{
    Poco::File dir(cacheDirName());

    // TODO: Actually handle URLs (file: and http:), not file names.
    if (dir.exists() && dir.isDirectory() && Poco::File(_docURL).exists() && Poco::File(_docURL).isFile())
    {
        if (getLastModified() != Poco::File(_docURL).getLastModified())
        {
            dir.remove(true);
       }
    }
}

std::unique_ptr<std::fstream> TileCache::lookupTile(int part, int width, int height, int tilePosX, int tilePosY, int tileWidth, int tileHeight)
{
    std::string dirName = cacheDirName();

    if (!Poco::File(dirName).exists() || !Poco::File(dirName).isDirectory())
        return nullptr;

    std::string fileName = dirName + "/" + cacheFileName(part, width, height, tilePosX, tilePosY, tileWidth, tileHeight);

    std::unique_ptr<std::fstream> result(new std::fstream(fileName, std::ios::in));

    return result;
}

void TileCache::saveTile(int part, int width, int height, int tilePosX, int tilePosY, int tileWidth, int tileHeight, const char *data, size_t size)
{
    std::string dirName = cacheDirName();

    Poco::File(dirName).createDirectories();

    std::string fileName = dirName + "/" + cacheFileName(part, width, height, tilePosX, tilePosY, tileWidth, tileHeight);

    std::fstream outStream(fileName, std::ios::out);
    outStream.write(data, size);
    outStream.close();

    // TODO: Actually handle URLs (file: and http:), not file names.
    if (!Poco::File(_docURL).exists() || !Poco::File(_docURL).isFile())
        return;
    std::fstream modTimeFile(dirName + "/modtime.txt", std::ios::out);
    modTimeFile << Poco::File(_docURL).getLastModified().raw() << std::endl;
    modTimeFile.close();
}

std::string TileCache::getStatus()
{
    std::string dirName = cacheDirName();

    if (!Poco::File(dirName).exists() || !Poco::File(dirName).isDirectory())
        return "";

    std::string fileName = dirName + "/status.txt";
    std::fstream statusStream(fileName, std::ios::in);
    if (!statusStream.is_open())
        return "";

    std::vector<char> result;
    statusStream.seekg(0, std::ios_base::end);
    std::streamsize size = statusStream.tellg();
    result.resize(size);
    statusStream.seekg(0, std::ios_base::beg);
    statusStream.read(result.data(), size);
    statusStream.close();

    if (result[result.size()-1] == '\n')
        result.resize(result.size() - 1);

    return std::string(result.data(), result.size());
}

void TileCache::saveStatus(const std::string& status)
{
    std::string dirName = cacheDirName();

    Poco::File(dirName).createDirectories();

    Poco::StringTokenizer tokens(status, " ", Poco::StringTokenizer::TOK_IGNORE_EMPTY | Poco::StringTokenizer::TOK_TRIM);

    assert(tokens[0] == "status:");

    std::string fileName = dirName + "/status.txt";
    std::fstream statusStream(fileName, std::ios::out);

    if (!statusStream.is_open())
        return;

    statusStream << status << std::endl;
    statusStream.close();
}

void TileCache::invalidateTiles(int part, int x, int y, int width, int height)
{
    std::string dirName = cacheDirName();

    std::vector<std::string> toBeRemoved;

    for (auto tileIterator = Poco::DirectoryIterator(dirName); tileIterator != Poco::DirectoryIterator(); ++tileIterator)
    {
        std::string baseName = tileIterator.path().getBaseName();

        int tilePart, tilePixelWidth, tilePixelHeight, tilePosX, tilePosY, tileWidth, tileHeight;

        if (parseCacheFileName(baseName, tilePart, tilePixelWidth, tilePixelHeight, tilePosX, tilePosY, tileWidth, tileHeight))
        {
            std::cout << "Tile " << baseName << " is " << tileWidth << "x" << tileHeight << "@+" << tilePosX << "+" << tilePosY << std::endl;
            if ((part == -1 || tilePart == part) &&
                tilePosX < x + width && tilePosX + tileWidth >= x &&
                tilePosY < y + height && tilePosY + tileHeight >= y)
            {
                std::cout << "Match!" << std::endl;
                toBeRemoved.push_back(tileIterator.path().toString());
            }
        }
    }

    for (auto i: toBeRemoved)
        std::remove(i.c_str());
}

void TileCache::invalidateTiles(int part, const std::string& tiles)
{
    Poco::StringTokenizer tokens(tiles, " ", Poco::StringTokenizer::TOK_IGNORE_EMPTY | Poco::StringTokenizer::TOK_TRIM);

    assert(tokens[0] == "invalidatetiles:");

    if (tokens.count() == 2 && tokens[1] == "EMPTY")
    {
        invalidateTiles(-1, 0, 0, INT_MAX, INT_MAX);
    }
    else if (tokens.count() != 5)
    {
        return;
    }
    else
    {
        int width(std::stoi(tokens[1]));
        int height(std::stoi(tokens[2]));
        int x(std::stoi(tokens[3]));
        int y(std::stoi(tokens[4]));

        invalidateTiles(part, x, y, width, height);
    }
}

std::string TileCache::cacheDirName()
{
    Poco::SHA1Engine digestEngine;

    digestEngine.update(_docURL.c_str(), _docURL.size());

    return (LOOLWSD_CACHEDIR "/" +
            Poco::DigestEngine::digestToHex(digestEngine.digest()).insert(3, "/").insert(2, "/").insert(1, "/"));
}

std::string TileCache::cacheFileName(int part, int width, int height, int tilePosX, int tilePosY, int tileWidth, int tileHeight)
{
    return (std::to_string(part) + "_" +
            std::to_string(width) + "x" + std::to_string(height) + "." +
            std::to_string(tilePosX) + "," + std::to_string(tilePosY) + "." +
            std::to_string(tileWidth) + "x" + std::to_string(tileHeight) + ".png");
}

bool TileCache::parseCacheFileName(std::string& fileName, int& part, int& width, int& height, int& tilePosX, int& tilePosY, int& tileWidth, int& tileHeight)
{
    return (std::sscanf(fileName.c_str(), "%d_%dx%d.%d,%d.%dx%d", &part, &width, &height, &tilePosX, &tilePosY, &tileWidth, &tileHeight) == 7);
}

Poco::Timestamp TileCache::getLastModified()
{
    std::fstream modTimeFile(cacheDirName() + "/modtime.txt", std::ios::in);

    if (!modTimeFile.is_open())
        return 0;

    Poco::Timestamp::TimeVal result;
    modTimeFile >> result;

    modTimeFile.close();
    return result;
}


/* vim:set shiftwidth=4 softtabstop=4 expandtab: */
