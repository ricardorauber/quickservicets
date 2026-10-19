# syntax=docker/dockerfile:1
# .NET 10 ASP.NET Core Minimal APIs on Kestrel, with Npgsql. Build context: this folder.

# 1. Restore and publish a Release build with ReadyToRun code for the target architecture.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.401 AS build
ARG TARGETARCH
WORKDIR /src
COPY QsBench.csproj ./
RUN dotnet restore -a $TARGETARCH
COPY . .
RUN dotnet publish -c Release -a $TARGETARCH --no-restore --no-self-contained -o /app

# 2. Runtime: the ASP.NET Core image, as its non-root "app" user.
FROM mcr.microsoft.com/dotnet/aspnet:10.0.12
ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_HTTP_PORTS= \
    PORT=8080 \
    UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads && chown app:app /data/uploads
WORKDIR /app
COPY --from=build /app ./
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "QsBench.dll"]
