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

#include <Poco/DigestEngine.h>
#include <Poco/DirectoryIterator.h>
#include <Poco/Exception.h>
#include <Poco/File.h>
#include <Poco/Path.h>
#include <Poco/SHA1Engine.h>
#include <Poco/StringTokenizer.h>
#include <Poco/Timestamp.h>
#include <Poco/URI.h>

#include "LOOLWSD.hpp"
#include "TileCache.hpp"

using Poco::DigestEngine;
using Poco::DirectoryIterator;
using Poco::File;
using Poco::SHA1Engine;
using Poco::StringTokenizer;
using Poco::SyntaxException;
using Poco::Timestamp;
using Poco::URI;

TileCache::TileCache(const std::string& docURL) :
    _docURL(docURL),
    _isEditing(false),
    _hasUnsavedChanges(false)
{
    File dir(toplevelCacheDirName());

    try
    {
        URI uri(_docURL);
        if (uri.getScheme() == "" ||
            uri.getScheme() == "file")
        {
            setupForFile(dir, uri.getPath());
        }
    }
    catch (SyntaxException& e)
    {
    }
}

std::unique_ptr<std::fstream> TileCache::lookupTile(int part, int width, int height, int tilePosX, int tilePosY, int tileWidth, int tileHeight)
{
    std::string cachedName = cacheFileName(part, width, height, tilePosX, tilePosY, tileWidth, tileHeight);

    if (_hasUnsavedChanges)
    {
        // try the Editing cache first
        std::string dirName = cacheDirName(true);
        std::string fileName =  + "/" + cachedName;
        File dir(dirName);

        if (dir.exists() && dir.isDirectory() && File(fileName).exists())
        {
            std::unique_ptr<std::fstream> result(new std::fstream(fileName, std::ios::in));
            return result;
        }
    }

    // skip tiles scheduled for removal from the Persistent cache (on save)
    if (_toBeRemoved.find(cachedName) != _toBeRemoved.end())
        return nullptr;

    // default to the content of the Persistent cache
    std::string dirName = cacheDirName(false);
    File dir(dirName);

    if (!dir.exists() || !dir.isDirectory())
        return nullptr;

    std::string fileName = dirName + "/" + cachedName;

    std::unique_ptr<std::fstream> result(new std::fstream(fileName, std::ios::in));

    return result;
}

void TileCache::saveTile(int part, int width, int height, int tilePosX, int tilePosY, int tileWidth, int tileHeight, const char *data, size_t size)
{
    if (_isEditing && !_hasUnsavedChanges)
        _hasUnsavedChanges = true;

    std::string dirName = cacheDirName(_hasUnsavedChanges);

    File(dirName).createDirectories();

    std::string fileName = dirName + "/" + cacheFileName(part, width, height, tilePosX, tilePosY, tileWidth, tileHeight);

    std::fstream outStream(fileName, std::ios::out);
    outStream.write(data, size);
    outStream.close();
}

std::string TileCache::getStatus()
{
    const char statusFile[] = "/status.txt";

    std::string dirName = cacheDirName(false);
    if (_hasUnsavedChanges)
    {
        // try the Editing cache first, and prefer its status.txt if it exists
        std::string editingDirName = cacheDirName(true);
        File dir(editingDirName);

        File status(editingDirName + statusFile);
        if (dir.exists() && dir.isDirectory() && status.exists() && !status.isDirectory())
            dirName = editingDirName;
    }

    if (!File(dirName).exists() || !File(dirName).isDirectory())
        return "";

    std::string fileName = dirName + statusFile;
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

void TileCache::documentSaved()
{
    // first remove the invalidated tiles from the Persistent cache
    std::string persistentDirName = cacheDirName(false);
    for (const auto& it : _toBeRemoved)
        File(persistentDirName + "/" + it).remove();

    // then move the new tiles from the Editing cache to Persistent
    for (auto tileIterator = DirectoryIterator(cacheDirName(true)); tileIterator != DirectoryIterator(); ++tileIterator)
        tileIterator->moveTo(persistentDirName);

    // update status
    _toBeRemoved.clear();
    _hasUnsavedChanges = false;
}

void TileCache::setEditing(bool editing)
{
    _isEditing = editing;
}

void TileCache::saveStatus(const std::string& status)
{
    std::string dirName = cacheDirName(_hasUnsavedChanges);

    File(dirName).createDirectories();

    StringTokenizer tokens(status, " ", StringTokenizer::TOK_IGNORE_EMPTY | StringTokenizer::TOK_TRIM);

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
    // in the Editing cache, remove immediately
    std::string editingDirName = cacheDirName(true);
    File editingDir(editingDirName);
    if (editingDir.exists() && editingDir.isDirectory())
    {
        for (auto tileIterator = DirectoryIterator(editingDir); tileIterator != DirectoryIterator(); ++tileIterator)
        {
            std::string fileName = tileIterator.path().getFileName();
            if (intersectsTile(fileName, part, x, y, width, height))
            {
                File(tileIterator.path()).remove();
            }
        }
    }

    // in the Persistent cache, add to _toBeRemoved for removal on save
    std::string persistentDirName = cacheDirName(false);
    File persistentDir(persistentDirName);
    if (persistentDir.exists() && persistentDir.isDirectory())
    {
        for (auto tileIterator = DirectoryIterator(persistentDir); tileIterator != DirectoryIterator(); ++tileIterator)
        {
            std::string fileName = tileIterator.path().getFileName();
            if (_toBeRemoved.find(fileName) == _toBeRemoved.end() && intersectsTile(fileName, part, x, y, width, height))
            {
                _toBeRemoved.insert(fileName);
            }
        }
    }
}

void TileCache::invalidateTiles(int part, const std::string& tiles)
{
    StringTokenizer tokens(tiles, " ", StringTokenizer::TOK_IGNORE_EMPTY | StringTokenizer::TOK_TRIM);

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

std::string TileCache::toplevelCacheDirName()
{
    SHA1Engine digestEngine;

    digestEngine.update(_docURL.c_str(), _docURL.size());

    return (LOOLWSD::cache + "/" +
            DigestEngine::digestToHex(digestEngine.digest()).insert(3, "/").insert(2, "/").insert(1, "/"));
}

std::string TileCache::cacheDirName(bool useEditingCache)
{
    if (useEditingCache)
        return toplevelCacheDirName() + "/editing";
    else
        return toplevelCacheDirName() + "/persistent";
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
    return (std::sscanf(fileName.c_str(), "%d_%dx%d.%d,%d.%dx%d.png", &part, &width, &height, &tilePosX, &tilePosY, &tileWidth, &tileHeight) == 7);
}

bool TileCache::intersectsTile(std::string& fileName, int part, int x, int y, int width, int height)
{
    int tilePart, tilePixelWidth, tilePixelHeight, tilePosX, tilePosY, tileWidth, tileHeight;

    if (parseCacheFileName(fileName, tilePart, tilePixelWidth, tilePixelHeight, tilePosX, tilePosY, tileWidth, tileHeight))
    {
        if (part != -1 && tilePart != part)
            return false;

        int left = std::max(x, tilePosX);
        int right = std::min(x + width, tilePosX + tileWidth);
        int top = std::max(y, tilePosY);
        int bottom = std::min(y + height, tilePosY + tileHeight);

        if (left <= right && top <= bottom)
            return true;
    }

    return false;
}

Timestamp TileCache::getLastModified()
{
    std::fstream modTimeFile(toplevelCacheDirName() + "/modtime.txt", std::ios::in);

    if (!modTimeFile.is_open())
        return 0;

    Timestamp::TimeVal result;
    modTimeFile >> result;

    modTimeFile.close();
    return result;
}

void TileCache::setupForFile(File& cacheDir, const std::string& path)
{
    if (File(path).exists() && File(path).isFile())
    {
        if (cacheDir.exists())
        {
            if (getLastModified() != File(path).getLastModified())
            {
                // document changed externally, clean up everything
                cacheDir.remove(true);
            }
            else
            {
                // remove only the Editing cache
                File editingCacheDir(cacheDirName(true));
                if (editingCacheDir.exists())
                    editingCacheDir.remove(true);
            }
        }
        cacheDir.createDirectories();
        std::fstream modTimeFile(cacheDir.path() + "/modtime.txt", std::ios::out);
        modTimeFile << File(path).getLastModified().raw() << std::endl;
        modTimeFile.close();
    }
}

/* vim:set shiftwidth=4 softtabstop=4 expandtab: */
